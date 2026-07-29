// Живой прогон приёмки issue #79 (список счетов по префиксам уходил в параметры
// виртуальной таблицы сериализованным) и issue #80 (маркер smoke-gate читал
// error.details.stage, которого в контракте нет).
//
// Всё, что нужно для запроса, добывается discovery: план счетов, бухгалтерский
// регистр, счета, виды субконто и дата остатков берутся из живой базы, а не из
// констант. Единственное имя, зашитое в пробе P4, — Справочник.Номенклатура: это
// значение по умолчанию самого инструмента get_inventory_balances_by_item, и при
// его отсутствии проба помечается SKIP, а не FAIL.
//
// Запуск:  node run_issue79_80.mjs [out.json]
// Окружение: MCP_URL, MCP_BASIC (как у scripts/mcp_contract_test.mjs).

import { writeFileSync } from 'node:fs';
import { call, payload, rpcCall, endpoint } from './rpc.mjs';

const OUT = process.argv[2] || 'issue79_80_live.json';
const probes = [];

function add(id, title, status, note, data) {
  probes.push({ id, title, status, note, data });
  const mark = status.padEnd(4, ' ');
  console.log(`[${mark}] ${id}  ${title}`);
  if (note) console.log(`        ${note}`);
}

async function tool(name, args) {
  return payload(await call(name, args));
}

function errText(result) {
  const err = result?.error || {};
  return JSON.stringify({
    code: err.code,
    error_code: result?.error_code ?? err.error_code,
    message: String(err.message || '').slice(0, 400),
  });
}

// Префикс счёта = код до первой точки: 62.01 -> 62. Уровень вложенности плана
// счетов конфигурация задаёт сама, поэтому длину префикса не фиксируем.
function prefixOf(code) {
  return String(code || '').split('.')[0];
}

function subcontoNames(account) {
  return (account.subconto || [])
    .slice()
    .sort((left, right) => Number(left.position) - Number(right.position))
    .map((item) => item.name);
}

function hasPositions(account, positions) {
  return positions.every((position) => (account.subconto || []).some((item) => Number(item.position) === position));
}

async function main() {
  const report = {
    issue: ['#79', '#80'],
    endpoint,
    started_at: new Date().toISOString(),
    fingerprint: {},
    discovery: {},
    probes,
  };

  // ---------- Отпечаток ревизии ----------
  const tools = await rpcCall('tools/list', {});
  const toolNames = (tools?.result?.tools ?? []).map((item) => item.name);
  const context = await tool('get_current_user_context', {});
  report.fingerprint = {
    tools_count: toolNames.length,
    has_get_inventory_balances_by_item: toolNames.includes('get_inventory_balances_by_item'),
    user_name: context?.auth_context?.user_name ?? context?.user_name ?? null,
    server: context?.server ?? null,
  };
  console.log(`endpoint: ${endpoint}`);
  console.log(`tools/list: ${toolNames.length}`);

  // ---------- Discovery ----------
  const passport = await tool('get_database_passport', {});
  const register = (passport?.accounting_registers ?? [])[0]?.register ?? null;
  const lastEntry = passport?.data_period?.last_entry ?? null;
  const asOf = typeof lastEntry === 'string' && lastEntry.length >= 10
    ? lastEntry.slice(0, 19)
    : new Date().toISOString().slice(0, 19);

  const charts = await tool('list_metadata_objects', { kinds: ['ПланСчетов'], limit: 5 });
  const chart = (charts?.objects ?? [])[0]?.full_name ?? null;

  const catalogs = await tool('list_metadata_objects', { kinds: ['Справочник'], limit: 1, include_details: false });
  const anyCatalog = (catalogs?.objects ?? [])[0]?.full_name ?? null;

  const map = chart
    ? await tool('get_accounting_accounts_map', { chart, include_empty_subconto: false, limit: 200 })
    : null;
  const accounts = (map?.accounts ?? []).filter((account) => account.code);

  report.discovery = {
    accounting_register: register,
    chart,
    any_catalog: anyCatalog,
    as_of: asOf,
    accounts_with_subconto: accounts.length,
  };
  console.log(`регистр: ${register}; план счетов: ${chart}; дата остатков: ${asOf}`);

  if (!register || !chart) {
    add('P0', 'discovery: бухгалтерский регистр и план счетов', 'FAIL',
      'без регистра или плана счетов пробы #79 не выполняются', report.discovery);
    return finish(report);
  }
  add('P0', 'discovery: бухгалтерский регистр и план счетов', 'PASS',
    `счетов с видами субконто: ${accounts.length}`, report.discovery);

  // ---------- P1. #80: stage виден клиенту, а не спрятан в details ----------
  if (!anyCatalog) {
    add('P1', '#80 stage при отказе до выполнения', 'SKIP', 'в базе не найден справочник', null);
  } else {
    const result = await tool('run_1c_query', {
      query: `ВЫБРАТЬ ПЕРВЫЕ 1 Т.Ссылка ИЗ ${anyCatalog}.ЗаведомоНетТакойТабличнойЧастиПробы КАК Т`,
      limit: 1,
    });
    const top = result?.stage ?? null;
    const inError = result?.error?.stage ?? null;
    const inDetails = result?.error?.details?.stage ?? null;
    const ok = (top === 'validation' || inError === 'validation');
    add('P1', '#80 stage при отказе до выполнения', ok ? 'PASS' : 'FAIL',
      `stage=${top}, error.stage=${inError}, error.details.stage=${inDetails} `
      + '(пустой details.stage — норма контракта, именно его читал сломанный маркер)',
      { ok: result?.ok, error_code: result?.error_code ?? result?.error?.error_code, top, inError, inDetails });
  }

  // ---------- P2. #79: get_accounting_balances_by_subconto_age ----------
  const agingAccount = accounts.find((account) => hasPositions(account, [1, 3]));
  if (!agingAccount) {
    add('P2', '#79 get_accounting_balances_by_subconto_age', 'SKIP',
      'нет счёта с видами субконто в позициях 1 и 3', null);
  } else {
    const prefix = prefixOf(agingAccount.code);
    const args = {
      accounting_register: register,
      as_of: asOf,
      account_code_prefixes: [prefix],
      balance_side: 'debit',
      subconto_kinds: subcontoNames(agingAccount),
      group_subconto_index: 1,
      age_subconto_index: 3,
      age_buckets: [90, 180, 365],
      limit: 5,
      include_query: true,
    };
    const result = await tool('get_accounting_balances_by_subconto_age', args);
    add('P2', '#79 get_accounting_balances_by_subconto_age', result?.ok === true ? 'PASS' : 'FAIL',
      result?.ok === true
        ? `счёт-образец ${agingAccount.code}, префикс ${prefix}, строк ${(result.rows ?? []).length}, бакетов ${(result.bucket_rows ?? []).length}`
        : `отказ: ${errText(result)}`,
      { args, ok: result?.ok, rows: (result?.rows ?? []).length, error: result?.error ?? null });
  }

  // ---------- P3. #79: compare_accounting_balances_by_subconto ----------
  const withCounterparty = accounts.filter((account) => hasPositions(account, [1]));
  const left = withCounterparty[0];
  const right = withCounterparty.find((account) => prefixOf(account.code) !== prefixOf(left?.code));
  if (!left || !right) {
    add('P3', '#79 compare_accounting_balances_by_subconto', 'SKIP',
      'нужны два счёта разных групп с субконто в позиции 1', null);
  } else {
    const args = {
      accounting_register: register,
      as_of: asOf,
      subconto_kinds: subcontoNames(left),
      match_subconto_index: 1,
      left_account_code_prefixes: [prefixOf(left.code)],
      left_balance_side: 'debit',
      right_account_code_prefixes: [prefixOf(right.code)],
      right_balance_side: 'credit',
      limit: 5,
      include_query: true,
    };
    const result = await tool('compare_accounting_balances_by_subconto', args);
    add('P3', '#79 compare_accounting_balances_by_subconto', result?.ok === true ? 'PASS' : 'FAIL',
      result?.ok === true
        ? `слева ${prefixOf(left.code)}, справа ${prefixOf(right.code)}, строк ${(result.rows ?? []).length}`
        : `отказ: ${errText(result)}`,
      { args, ok: result?.ok, rows: (result?.rows ?? []).length, error: result?.error ?? null });
  }

  // ---------- P4. #79: get_inventory_balances_by_item ----------
  // Инструмент не покрыт ни одним кейсом контракт-теста до этой правки, поэтому
  // его отказ «Неверные параметры» не был виден ни одному прогону.
  const itemType = 'Справочник.Номенклатура';
  const structure = await tool('get_metadata_structure', { type: itemType });
  if (structure?.ok !== true) {
    add('P4', '#79 get_inventory_balances_by_item', 'SKIP', `${itemType} отсутствует в конфигурации`, null);
  } else {
    const sample = await tool('run_1c_query', {
      query: `ВЫБРАТЬ ПЕРВЫЕ 1 Т.Ссылка КАК Ссылка ИЗ ${itemType} КАК Т`,
      limit: 1,
    });
    const itemRef = sample?.rows?.[0]?.Ссылка ?? null;
    if (!itemRef?.uuid) {
      add('P4', '#79 get_inventory_balances_by_item', 'SKIP', `${itemType} пуст`, null);
    } else {
      const args = {
        accounting_register: register,
        item_ref: { type: itemRef.type, uuid: itemRef.uuid },
        as_of: asOf,
        include_query: true,
        limit: 5,
      };
      const result = await tool('get_inventory_balances_by_item', args);
      const skippable = result?.ok === false && result?.error?.code === 'metadata_not_found';
      add('P4', '#79 get_inventory_balances_by_item', skippable ? 'SKIP' : (result?.ok === true ? 'PASS' : 'FAIL'),
        skippable
          ? `виды субконто Номенклатура/Склады не найдены: ${String(result?.error?.message || '').slice(0, 200)}`
          : (result?.ok === true
            ? `номенклатура «${itemRef.presentation}», строк ${(result.rows ?? []).length}, префиксы ${JSON.stringify(result.account_code_prefixes)}`
            : `отказ: ${errText(result)}`),
        { args, ok: result?.ok, rows: (result?.rows ?? []).length, prefixes: result?.account_code_prefixes ?? null, error: result?.error ?? null });
    }
  }

  // ---------- P5. Контроль непустоты: 0 строк сам по себе ничего не доказывает ----------
  // Тот же отбор по счёту, но список ссылок собирает клиент. Если здесь строк нет,
  // нули в P2/P3 говорят о данных, а не о работе инструментов.
  const controlAccounts = accounts.slice(0, 20)
    .map((account) => account.account)
    .filter((ref) => ref && ref.uuid)
    .map((ref) => ({ kind: 'ref', type: ref.type, uuid: ref.uuid }));
  if (controlAccounts.length === 0) {
    add('P5', 'контроль непустоты остатков', 'SKIP', 'в карте счетов нет ссылок на счета', null);
  } else {
    // КОЛИЧЕСТВО(*) единственным полем выборки бухгалтерская ВТ Остатки не принимает:
    // платформа отвечает «В выборке должно быть указано хотя бы одно измерение или
    // ресурс» (проверено живьём 29.07.2026, прогон до деплоя). Поэтому выбираются
    // измерение и ресурсы, а строки считаются на клиенте.
    const control = await tool('run_1c_query', {
      query: `ВЫБРАТЬ Остатки.Счет КАК Счет, Остатки.СуммаОстатокДт КАК СуммаДт,`
        + ` Остатки.СуммаОстатокКт КАК СуммаКт`
        + ` ИЗ ${register}.Остатки(&Период, Счет В (&СписокСчетов), , ) КАК Остатки`,
      parameters: {
        Период: { kind: 'datetime', value: asOf },
        // Ловушка формата: массив только {kind:'array', value:[...]}, ссылка только с uuid.
        // Неверный ключ раньше давал ноль строк без ошибки — с PR #78 это ошибка.
        СписокСчетов: { kind: 'array', value: controlAccounts },
      },
      limit: 50,
    });
    const count = (control?.rows ?? []).length;
    add('P5', 'контроль непустоты остатков', control?.ok === true && count > 0 ? 'PASS' : 'FAIL',
      control?.ok === true
        ? `строк остатков по ${controlAccounts.length} счетам: ${count}${count === 0 ? ' — данных на дату нет, нули в P2–P4 неинформативны' : ''}`
        : `отказ: ${errText(control)}`,
      { ok: control?.ok, count, accounts: controlAccounts.length, error: control?.error ?? null });
  }

  // ---------- P6. Потолок списка счетов (информационно) ----------
  // Ветка «префиксам соответствует не меньше max_query_rows счетов» возбуждает
  // ошибку вместо усечения. На контуре с меньшим числом счетов она недостижима —
  // фиксируем факт, а не выдаём непроверенное за проверенное.
  const totalAccounts = await tool('run_1c_query', {
    query: `ВЫБРАТЬ КОЛИЧЕСТВО(*) КАК Кол ИЗ ${chart} КАК Счета`,
    limit: 1,
  });
  const accountsTotal = Number(totalAccounts?.rows?.[0]?.Кол ?? 0);
  add('P6', 'потолок списка счетов (max_query_rows=1000)', 'INFO',
    `счетов в ${chart}: ${accountsTotal} — ветка потолка ${accountsTotal >= 1000 ? 'достижима' : 'на этом контуре недостижима и остаётся непроверенной'}`,
    { accounts_total: accountsTotal });

  return finish(report);
}

function finish(report) {
  report.finished_at = new Date().toISOString();
  const failed = probes.filter((probe) => probe.status === 'FAIL');
  report.summary = {
    pass: probes.filter((probe) => probe.status === 'PASS').length,
    fail: failed.length,
    skip: probes.filter((probe) => probe.status === 'SKIP').length,
    info: probes.filter((probe) => probe.status === 'INFO').length,
  };
  writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\nитог: PASS ${report.summary.pass}, FAIL ${report.summary.fail}, SKIP ${report.summary.skip}, INFO ${report.summary.info}`);
  console.log(`отчёт: ${OUT}`);
  if (failed.length > 0) process.exitCode = 1;
  return report;
}

main().catch((error) => {
  console.error(`сорвано: ${error.message}`);
  process.exitCode = 2;
});
