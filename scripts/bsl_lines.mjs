#!/usr/bin/env node
// Общий разбор текста BSL для офлайн-ворот: снятие строковых литералов и
// комментариев. Единственный источник этой логики на все ворота — до него
// существовали три независимые копии (`bsl_predeploy_check`,
// `bsl_call_resolution`, `bsl_block_balance`), и правка одной не чинила
// остальные (ТЗ-1 R-2).
//
// ГЛАВНОЕ ОТЛИЧИЕ ОТ ПРЕЖНИХ КОПИЙ: литерал понимается многострочным.
// Прежние сканеры сбрасывали флаг «внутри строки» на каждой новой строке с
// обоснованием «в языке 1С строка не переносится без явной склейки». Это
// неверно: продолжение через «|» — штатная конструкция языка, и весь текст
// запросов в MCP_LegalSources написан именно так. Цена ошибки замерена
// 13.08.2026: единственный красный модуль из 17 у предполётной проверки и
// 37 из 40 «неразрешённых имён» — оба следствия одного этого дефекта. Ворота,
// красные всегда, сигналом не являются (#144, #143).
//
// Правила языка, которые здесь реализованы:
//   • литерал открывается кавычкой и закрывается кавычкой;
//   • удвоенная кавычка внутри литерала — экранированная кавычка, а не конец;
//   • литерал может продолжаться на следующей строке, если та (после
//     необязательных пробелов) начинается с «|»; сам «|» и отступ до него —
//     синтаксис, а не содержимое;
//   • пустая строка литерал не прерывает — проверяется следующая непустая;
//   • «//» вне литерала начинает комментарий до конца строки; ВНУТРИ литерала
//     это содержимое. Обратное тоже важно: кавычка внутри комментария литерал
//     не открывает — прежние копии этого не различали и на комментарии с
//     нечётным числом кавычек давали ложный провал.
//
// Кавычки в очищенном тексте СОХРАНЯЮТСЯ, содержимое заменяется пробелами:
// иначе вызов Ф("текст") выглядел бы как Ф() и проверка арности ломалась.
// Длина строк и их количество сохраняются — номера строк и колонок остаются
// пригодными для сообщений.

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Разбирает текст модуля. Возвращает:
//   rawLines   — исходные строки (для проверок, которым нужен текст как есть);
//   cleanLines — строки без содержимого литералов и без комментариев;
//   clean      — они же, склеенные через \n;
//   unclosed   — номера строк, где литерал открылся и не был закрыт по
//                правилам языка (незакрытая кавычка — настоящий провал).
export function scanBsl(text) {
  const rawLines = text.split(/\r?\n/);
  const cleanLines = [];
  const unclosed = [];
  let inString = false;
  let openLine = 0;

  for (let i = 0; i < rawLines.length; i += 1) {
    const line = rawLines[i];
    let out = "";
    let pos = 0;

    if (inString) {
      const cont = /^[ \t]*\|/.exec(line);
      if (cont) {
        // «|» и отступ до него — синтаксис продолжения: заменяем пробелами,
        // чтобы колонки не сдвинулись.
        out = " ".repeat(cont[0].length);
        pos = cont[0].length;
      } else if (line.trim() === "") {
        cleanLines.push("");
        continue;
      } else {
        // Литерал не продолжен строкой с «|» — значит он не был закрыт.
        // Дальше строка разбирается как обычный код: восстановление состояния
        // важнее точности после первой же настоящей ошибки.
        unclosed.push(openLine);
        inString = false;
      }
    }

    while (pos < line.length) {
      const ch = line[pos];
      if (inString) {
        if (ch === '"') {
          if (line[pos + 1] === '"') { out += "  "; pos += 2; continue; }
          inString = false;
          out += '"';
          pos += 1;
          continue;
        }
        out += " ";
        pos += 1;
        continue;
      }
      if (ch === '"') {
        inString = true;
        openLine = i + 1;
        out += '"';
        pos += 1;
        continue;
      }
      if (ch === "/" && line[pos + 1] === "/") break; // комментарий до конца строки
      out += ch;
      pos += 1;
    }

    cleanLines.push(out);
  }

  if (inString) unclosed.push(openLine);

  return { rawLines, cleanLines, clean: cleanLines.join("\n"), unclosed };
}

// Совместимость с прежним вызовом strip(text) в скриптах ворот.
export function stripBsl(text) {
  return scanBsl(text).clean;
}

// Список .bsl из git, а не обходом шелла: на путях с кириллицей
// (`Forms/Форма/Module.bsl`) шелл-цикл молча роняет файл, и он выглядит
// проверенным, не будучи проверенным (ТЗ-1 R-6). core.quotepath=false и -z —
// чтобы не разбирать экранирование не-ASCII имён.
export function bslFilesFromGit(root = "src") {
  const out = execFileSync("git", ["-c", "core.quotepath=false", "ls-files", "-z", "--", root], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return out.split("\0").filter((p) => p.endsWith(".bsl"));
}

// Разбор аргументов, общий для всех трёх ворот: либо перечисленные файлы,
// либо --all (весь src из git).
export function targetsFromArgv(argv, { root = "src" } = {}) {
  const files = [];
  let all = false;
  for (const arg of argv) {
    if (arg === "--all") all = true;
    else if (!arg.startsWith("--")) files.push(arg);
  }
  if (all) return { files: bslFilesFromGit(root), all: true };
  return { files, all: false };
}
