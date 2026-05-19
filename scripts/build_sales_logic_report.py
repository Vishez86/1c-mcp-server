from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph


ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "reports"
PDF_PATH = OUT_DIR / "sales_logic_report.pdf"

PAGE_W, PAGE_H = A4

FONT_REGULAR = "Arial"
FONT_BOLD = "Arial-Bold"
FONT_CODE = "Consolas"


@dataclass(frozen=True)
class MonthRow:
    month: str
    revenue: float
    cost: float
    gross_profit: float


@dataclass(frozen=True)
class DocRow:
    doc: str
    revenue: float
    cost: float
    gross_profit: float


CONTEXT = {
    "infobase": "Бухгалтерия предприятия КОРП, редакция 3.0",
    "configuration_version": "3.0.192.25",
    "platform_version": "8.3.27.2130",
    "mcp_server": "universal-1c-mcp 0.1.0, read-only",
    "generated_at": "2026-05-19",
    "period": "2024-01-09 - 2025-08-31",
}

TOTALS = {
    "revenue": 119_828_696.45,
    "cost": 89_732_844.56,
    "gross_profit": 30_095_851.89,
    "postings": 13_559,
    "first_posting": "2024-01-09 12:00:00",
    "last_posting": "2025-08-31 23:59:59",
}

MONTHLY = [
    MonthRow("2024-01", 5353995, 3983044.86, 1370950.14),
    MonthRow("2024-02", 6035800, 4425166.81, 1610633.19),
    MonthRow("2024-03", 8173245, 5993742.02, 2179502.98),
    MonthRow("2024-04", 3981995, 2948378.6, 1033616.4),
    MonthRow("2024-05", 5063670, 3750797.07, 1312872.93),
    MonthRow("2024-06", 4985960, 3697589.92, 1288370.08),
    MonthRow("2024-07", 5932045, 4348325.79, 1583719.21),
    MonthRow("2024-08", 6537625, 4776295.28, 1761329.72),
    MonthRow("2024-09", 4214647.66, 2732736.1, 1481911.56),
    MonthRow("2024-10", 8871127.91, 5408651.49, 3462476.42),
    MonthRow("2024-11", 4689358.34, 3453163.46, 1236194.88),
    MonthRow("2024-12", 5065000.03, 3566646.45, 1498353.58),
    MonthRow("2025-01", 7336398.5, 6208815.46, 1127583.04),
    MonthRow("2025-02", 6533320.72, 5464926.66, 1068394.06),
    MonthRow("2025-03", 4257997.86, 3517410.58, 740587.28),
    MonthRow("2025-04", 4569003.55, 3759550.57, 809452.98),
    MonthRow("2025-05", 7379845.12, 5667632.1, 1712213.02),
    MonthRow("2025-06", 6578201.58, 5163232.37, 1414969.21),
    MonthRow("2025-07", 8227523.88, 6357647.39, 1869876.49),
    MonthRow("2025-08", 6041936.3, 4509091.58, 1532844.72),
]

TOP_DOCS = [
    DocRow("Регламентная операция КП00-000028 от 31.03.2025", 0, -1317696.24, 1317696.24),
    DocRow("Реализация КП00-000014 от 01.10.2024", 1058000, 458124.15, 599875.85),
    DocRow("Регламентная операция КП00-000099 от 30.11.2024", 0, -450609.54, 450609.54),
    DocRow("Оказание услуг 0000-000001 от 17.08.2025", 405000, 0, 405000),
    DocRow("Реализация КП00-000008 от 12.10.2024", 700000, 322191.78, 377808.22),
    DocRow("Реализация КП00-000002 от 29.10.2024", 700000, 322445.09, 377554.91),
    DocRow("Отчет о розничных продажах КП00-000002 от 31.05.2025", 448200, 206421.85, 241778.15),
    DocRow("Отчет комиссионера КП00-000005 от 31.05.2025", 335000, 140299.91, 194700.09),
]

RETURNS = {
    "buyer_returns_amount": -6655.46,
    "realization_adjustments_amount": 700,
    "negative_postings_amount": -2387558.75,
    "buyer_returns_postings": 2,
    "realization_adjustments_postings": 2,
}

ACCOUNT_BREAKDOWN = [
    ("90.01.1", "Выручка по основной системе налогообложения", 119_828_696.45, 6511),
    ("90.02.1", "Себестоимость продаж по основной системе налогообложения", 89_732_844.56, 7048),
]

OPERATION_EXPLANATIONS = [
    {
        "title": "Регламентная операция КП00-000028",
        "subtitle": "Корректировка стоимости номенклатуры · 31.03.2025 · Конфетпром ООО",
        "effect": "Эффект на валовую прибыль: +1 317 696 ₽",
        "metrics": "Выручка: 0 ₽ · Себестоимость: -1 317 696 ₽ · Проводок в разборе: 45",
        "movements": [
            "Дт 90.02.1 Кт 45.02: -1 337 578 ₽",
            "Дт 90.02.1 Кт 43: +19 881 ₽",
            "Дт 45.02 Кт 43: -1 420 052 ₽",
            "Дт 20.01 Кт 10.01: -8 ₽",
        ],
        "meaning": (
            "По бизнес-смыслу: в конце месяца 1С пересчитала фактическую стоимость списания/отгрузки номенклатуры. "
            "Основной массив идет через 43 “Готовая продукция”, 45.02 “Отгруженная продукция/товары” и 90.02.1 "
            "“Себестоимость продаж”. Это ровно та логика, которую 1c-meta описывает для “Анализа продаж”: "
            "себестоимость учитывает не только первичные реализации, но и корректировки стоимости, сделанные закрытием месяца."
        ),
    },
    {
        "title": "Реализация КП00-000014",
        "subtitle": "Реализация товаров/готовой продукции · 01.10.2024",
        "effect": "Эффект на валовую прибыль: +599 876 ₽",
        "metrics": "Выручка: 1 058 000 ₽ · Себестоимость: 458 124 ₽ · НДС отдельно: 176 333 ₽",
        "movements": [
            "Дт 62.01 Кт 90.01.1: +1 058 000 ₽",
            "Дт 90.02.1 Кт 43: +458 124 ₽",
            "Дт 90.03 Кт 68.02: +176 333 ₽",
            "Дт 45.02 Кт 43: +332 126 ₽",
        ],
        "meaning": (
            "По бизнес-смыслу: документ отражает продажу покупателю. Дебет 62.01 показывает задолженность покупателя, "
            "кредит 90.01.1 формирует выручку основной деятельности, а дебет 90.02.1 с кредитом 43 списывает фактическую "
            "себестоимость готовой продукции. НДС ушел отдельной проводкой через 90.03 и 68.02 и в валовую прибыль не входит. "
            "Поэтому вклад документа равен выручке минус себестоимость: 1 058 000 - 458 124 ₽."
        ),
    },
    {
        "title": "Регламентная операция КП00-000099",
        "subtitle": "Корректировка стоимости номенклатуры · 30.11.2024",
        "effect": "Эффект на валовую прибыль: +450 610 ₽",
        "metrics": "Выручка: 0 ₽ · Себестоимость: -450 610 ₽ · Проводок в разборе: 34",
        "movements": [
            "Дт 90.02.1 Кт 20.02: -450 000 ₽",
            "Дт 90.02.1 Кт 45.02: -610 ₽",
            "Дт 20.01 Кт 10.01: -423 ₽",
            "Дт 45.02 Кт 43: -1 226 ₽",
        ],
        "meaning": (
            "По бизнес-смыслу: это еще одна операция закрытия месяца, но ее основной эффект пришел через 20.02 и 90.02.1. "
            "1С уточнила стоимость ранее списанных работ/продукции и уменьшила себестоимость продаж. В отчете такая запись "
            "становится положительным вкладом в валовую прибыль, потому что формула “выручка минус себестоимость” реагирует "
            "на отрицательный оборот по 90.02 как на уменьшение расходной части."
        ),
    },
    {
        "title": "Оказание услуг 0000-000001",
        "subtitle": "Оказание услуг · 17.08.2025",
        "effect": "Эффект на валовую прибыль: +405 000 ₽",
        "metrics": "Выручка: 405 000 ₽ · Себестоимость в 90.02: 0 ₽ · Проводок в разборе: 3",
        "movements": [
            "Дт 62.01 Кт 90.01.1: +405 000 ₽",
        ],
        "meaning": (
            "По бизнес-смыслу: документ “Оказание услуг” начисляет выручку по оказанным услугам нескольким контрагентам. "
            "1c-meta описывает, что для таких услуг счета доходов и расходов задаются на закладке “Счета учета”, а выручка "
            "попадает в продажи основной деятельности. В найденных движениях по этой операции есть только кредит 90.01.1, "
            "а оборота по 90.02 нет, поэтому вся сумма выручки попала в валовую прибыль."
        ),
    },
    {
        "title": "Реализация КП00-000008",
        "subtitle": "Реализация товаров/готовой продукции · 12.10.2024",
        "effect": "Эффект на валовую прибыль: +377 808 ₽",
        "metrics": "Выручка: 700 000 ₽ · Себестоимость: 322 192 ₽ · НДС отдельно: 116 667 ₽",
        "movements": [
            "Дт 62.01 Кт 90.01.1: +700 000 ₽",
            "Дт 90.02.1 Кт 43: +322 192 ₽",
            "Дт 90.03 Кт 68.02: +116 667 ₽",
            "Дт 45.02 Кт 43: +300 240 ₽",
        ],
        "meaning": (
            "По бизнес-смыслу: это классическая реализация с признанием выручки и списанием себестоимости готовой продукции. "
            "Кредит 90.01.1 дает сумму продажи, дебет 90.02.1 с кредитом 43 показывает стоимость проданной продукции, а НДС "
            "отражается отдельно и не уменьшает показатель валовой прибыли. Поэтому документ дал 700 000 - 322 192 ₽."
        ),
    },
]

CODE_SNIPPETS = [
    {
        "title": "Как код отделяет выручку от себестоимости",
        "source": "code/CommonModules/НалоговыйУчет/Ext/Module.bsl:146",
        "routine": "Функция СчетаВыручкиСебестоимости(Период, Организация) Экспорт",
        "comment": (
            "Этот фрагмент подтверждает главный принцип отчета: 1С работает не с произвольными документами, "
            "а с иерархиями счетов плана счетов. Выручка берется из ветки “Выручка”, себестоимость продаж — "
            "из ветки “СебестоимостьПродаж”. Поэтому в нашем отчете используются 90.01.1 и 90.02.1."
        ),
        "lines": [
            "СчетаВыручкиСебестоимости.Вставить(\"Выручка\", Новый Соответствие);",
            "СчетаВыручкиСебестоимости.Вставить(\"СебестоимостьПродаж\", Новый Соответствие);",
            "",
            "// Выручка: счета в иерархии предопределенного счета Выручка",
            "Хозрасчетный.Ссылка В ИЕРАРХИИ (ЗНАЧЕНИЕ(ПланСчетов.Хозрасчетный.Выручка))",
            "",
            "// Себестоимость: счета в иерархии предопределенного счета СебестоимостьПродаж",
            "Хозрасчетный.Ссылка В ИЕРАРХИИ (ЗНАЧЕНИЕ(ПланСчетов.Хозрасчетный.СебестоимостьПродаж))",
            "",
            "// Исключение специальных режимов, если они не должны попадать в базовый расчет",
            "И СчетаДоходовИРасходовЕНВД.Счет ЕСТЬ NULL",
        ],
    },
    {
        "title": "Как реализация формирует выручку",
        "source": "code/CommonModules/УчетДоходовРасходов/Ext/Module.bsl:1195",
        "routine": "Процедура СформироватьДвиженияРеализацияСобственныхТоваровУслуг(...)",
        "comment": (
            "Этот код объясняет операции “Реализация КП00-000014” и “Реализация КП00-000008”. "
            "В цикле по строкам реализации создается проводка: дебет берется из расчетного корреспондентского "
            "счета, кредит — из счета доходов. В фактических данных это стало Дт 62.01 Кт 90.01.1."
        ),
        "lines": [
            "Для каждого СтрокаТаблицы Из ТаблицаВыручкиОтРеализации Цикл",
            "    Проводка = Движения.Хозрасчетный.Добавить();",
            "    Проводка.Период      = Период;",
            "    Проводка.Организация = Организация;",
            "    Проводка.Сумма       = СтрокаТаблицы.СуммаБУ;",
            "",
            "    // Дебет: счет расчетов с покупателем, в отчете это 62.01",
            "    Проводка.СчетДт = СтрокаТаблицы.КорСчет;",
            "",
            "    // Кредит: счет доходов, в отчете это 90.01.1",
            "    Проводка.СчетКт = СтрокаТаблицы.СчетДоходов;",
            "КонецЦикла;",
            "",
            "Движения.Хозрасчетный.Записывать = Истина;",
        ],
    },
    {
        "title": "Как закрытие месяца записывает корректировки себестоимости",
        "source": "code/CommonModules/РасчетСебестоимости/Ext/Module.bsl:430",
        "routine": "Процедура СформироватьДвиженияРасчетСебестоимости(...) Экспорт",
        "comment": (
            "Этот фрагмент относится к регламентным операциям КП00-000028 и КП00-000099. "
            "Алгоритм получает уже рассчитанную таблицу проводок и переносит ее в регистр Хозрасчетный, "
            "сохраняя счета, суммы и аналитику. Поэтому отрицательные обороты по 90.02.1 становятся "
            "уменьшением себестоимости в отчете."
        ),
        "lines": [
            "Если Не ЗначениеЗаполнено(Проводки) Тогда",
            "    Возврат;",
            "КонецЕсли;",
            "",
            "Для Каждого СтрокаПроводки Из Проводки Цикл",
            "    Проводка = Движения.Хозрасчетный.Добавить();",
            "    Проводка.Период      = Период;",
            "    Проводка.Организация = Организация;",
            "",
            "    // Переносит СчетДт, СчетКт, Сумму и прочие поля из расчетной строки",
            "    ЗаполнитьЗначенияСвойств(Проводка, СтрокаПроводки);",
            "",
            "    // Дальше код восстанавливает аналитику субконто по счетам",
            "    БухгалтерскийУчет.УстановитьСубконтоПоКешуСвойствСчета(...);",
            "КонецЦикла;",
            "",
            "Движения.Хозрасчетный.Записывать = Истина;",
        ],
    },
    {
        "title": "Как оказание услуг связано с движениями и расходным счетом",
        "source": "code/CommonModules/УчетНДС/Ext/Module.bsl:533; code/Catalogs/НастройкиУчетаЗатрат/Ext/ManagerModule.bsl:1056",
        "routine": "СформироватьДвиженияОказаниеУслуг(...) / ТребуетсяСчетРасходовПоОказаниюУслуг(...)",
        "comment": (
            "Эти фрагменты объясняют операцию “Оказание услуг 0000-000001”. Код НДС в конце вызывает формирование "
            "проводок реализации услуг, а отдельная функция определяет, требуется ли в документе счет расходов. "
            "В найденном документе движения по 90.02 отсутствуют, поэтому вся сумма 405 000 ₽ попала в валовую прибыль."
        ),
        "lines": [
            "// НДС-модуль после подготовки данных формирует проводки реализации услуг",
            "СформироватьПроводкиРеализацияТоваровУслуг(",
            "    Параметры.РеализованныеТоварыУслуги, Реквизиты, Движения, Отказ);",
            "",
            "// Настройка затрат определяет, нужен ли счет расходов в документах оказания услуг",
            "Функция ТребуетсяСчетРасходовПоОказаниюУслуг(Период, Организация) Экспорт",
            "    Возврат БухгалтерскийУчетПовтИсп.ТребуетсяСчетРасходовПоОказаниюУслуг(",
            "        УчетнаяПолитика.ПериодКеша(Период), Организация);",
            "КонецФункции",
        ],
    },
]

LOGIC_POINTS = [
    "Продажи берутся как оборот по кредиту 90.01: это отгруженные товары, продукция и услуги по основной деятельности, независимо от факта оплаты.",
    "Прочие доходы по счету 91 в расчет не включаются: логика отчета отделяет операционную продажу от прочих хозяйственных событий.",
    "Себестоимость определяется движениями Дт 90.02 Кт 41, 43, 10; для товаров в продажных ценах 41.11 сумма очищается от торговой наценки 42.",
    "Валовая прибыль считается как выручка минус себестоимость. Корректировки себестоимости и торговой наценки, выполненные закрытием месяца, остаются в расчете.",
    "Возвраты покупателей и сторно не отбрасываются: они попадают в обороты регистра со своим знаком и уменьшают продажи или себестоимость.",
    "Документ возврата с документом отгрузки восстанавливает стоимость по исходной реализации; без документа отгрузки учетная себестоимость должна быть задана в документе.",
]


def register_fonts() -> None:
    pdfmetrics.registerFont(TTFont(FONT_REGULAR, r"C:\Windows\Fonts\arial.ttf"))
    pdfmetrics.registerFont(TTFont(FONT_BOLD, r"C:\Windows\Fonts\arialbd.ttf"))
    pdfmetrics.registerFont(TTFont(FONT_CODE, r"C:\Windows\Fonts\consola.ttf"))


def rub(value: float, digits: int = 0) -> str:
    rounded = f"{value:,.{digits}f}".replace(",", " ").replace(".", ",")
    return f"{rounded} ₽"


def short_rub(value: float) -> str:
    sign = "-" if value < 0 else ""
    abs_value = abs(value)
    if abs_value >= 1_000_000:
        return f"{sign}{abs_value / 1_000_000:.1f}".replace(".", ",") + " млн ₽"
    if abs_value >= 1_000:
        return f"{sign}{abs_value / 1_000:.0f} тыс ₽"
    return rub(value)


def percent(value: float) -> str:
    return f"{value:.1f}%".replace(".", ",")


def rounded_rect(c: canvas.Canvas, x: float, y: float, w: float, h: float, fill, stroke=None, radius: float = 12) -> None:
    c.setFillColor(fill)
    c.setStrokeColor(stroke or fill)
    c.roundRect(x, y, w, h, radius, fill=1, stroke=1 if stroke else 0)


def draw_text(c: canvas.Canvas, text: str, x: float, y: float, size: float, color, bold: bool = False) -> None:
    c.setFont(FONT_BOLD if bold else FONT_REGULAR, size)
    c.setFillColor(color)
    c.drawString(x, y, text)


def draw_right(c: canvas.Canvas, text: str, x: float, y: float, size: float, color, bold: bool = False) -> None:
    c.setFont(FONT_BOLD if bold else FONT_REGULAR, size)
    c.setFillColor(color)
    c.drawRightString(x, y, text)


def draw_wrapped(
    c: canvas.Canvas,
    text: str,
    x: float,
    y: float,
    width: float,
    size: float,
    color,
    leading: float | None = None,
    bold: bool = False,
) -> float:
    """Draw paragraph from a top-left point and wrap by real PDF width."""
    leading = leading or size * 1.35
    style = ParagraphStyle(
        "wrapped",
        parent=getSampleStyleSheet()["BodyText"],
        fontName=FONT_BOLD if bold else FONT_REGULAR,
        fontSize=size,
        leading=leading,
        textColor=color,
        spaceAfter=0,
        spaceBefore=0,
        wordWrap="LTR",
    )
    paragraph = Paragraph(escape(text), style)
    _, height = paragraph.wrap(width, 1000)
    paragraph.drawOn(c, x, y - height)
    return y - height


def draw_shell(c: canvas.Canvas, title: str, subtitle: str, page_no: int) -> None:
    c.setFillColor(colors.HexColor("#ecfeff"))
    c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    c.setFillColor(colors.HexColor("#fff7ed"))
    c.circle(PAGE_W - 42 * mm, PAGE_H - 35 * mm, 55 * mm, fill=1, stroke=0)
    c.setFillColor(colors.HexColor("#eef2ff"))
    c.circle(26 * mm, 22 * mm, 65 * mm, fill=1, stroke=0)
    draw_text(c, title, 22 * mm, PAGE_H - 31 * mm, 26, colors.HexColor("#0f172a"), True)
    draw_text(c, subtitle, 22 * mm, PAGE_H - 42 * mm, 11.5, colors.HexColor("#475569"))
    draw_text(
        c,
        "Источник: 1c-korp, регистр Хозрасчетный; логика: 1c-meta.",
        22 * mm,
        13 * mm,
        7.6,
        colors.HexColor("#64748b"),
    )
    draw_right(c, f"{CONTEXT['generated_at']} · стр. {page_no}", PAGE_W - 22 * mm, 13 * mm, 7.6, colors.HexColor("#64748b"))


def metric_card(c: canvas.Canvas, x: float, y: float, label: str, value: str, sub: str, accent) -> None:
    rounded_rect(c, x, y, 50 * mm, 32 * mm, colors.white, colors.HexColor("#e2e8f0"), 8)
    rounded_rect(c, x, y + 30 * mm, 50 * mm, 2 * mm, accent, accent, 1)
    draw_text(c, label, x + 5 * mm, y + 22 * mm, 8.8, colors.HexColor("#64748b"), True)
    draw_text(c, value, x + 5 * mm, y + 12 * mm, 19, colors.HexColor("#0f172a"), True)
    draw_text(c, sub, x + 5 * mm, y + 5 * mm, 8.8, colors.HexColor("#64748b"))


def draw_legend(c: canvas.Canvas, x: float, y: float, color, label: str) -> None:
    c.setFillColor(color)
    c.circle(x, y + 1, 3.1, fill=1, stroke=0)
    draw_text(c, label, x + 6, y - 2, 8.5, colors.HexColor("#334155"), True)


def line_chart(c: canvas.Canvas, x: float, y: float, w: float, h: float) -> None:
    max_value = max(max(row.revenue, row.cost, row.gross_profit) for row in MONTHLY)

    def px(index: int) -> float:
        return x + index / (len(MONTHLY) - 1) * w

    def py(value: float) -> float:
        return y + value / max_value * h

    c.setLineWidth(0.35)
    c.setStrokeColor(colors.HexColor("#cbd5e1"))
    for grid in range(5):
        yy = y + grid / 4 * h
        c.line(x, yy, x + w, yy)
        draw_right(c, short_rub(max_value * grid / 4), x - 4, yy - 2, 7, colors.HexColor("#64748b"))

    def draw_series(values: list[float], color, width: float) -> None:
        c.setStrokeColor(color)
        c.setLineWidth(width)
        points = [(px(i), py(v)) for i, v in enumerate(values)]
        for (x1, y1), (x2, y2) in zip(points, points[1:]):
            c.line(x1, y1, x2, y2)
        c.setFillColor(color)
        for point_x, point_y in points[::2]:
            c.circle(point_x, point_y, 2, fill=1, stroke=0)

    draw_series([row.revenue for row in MONTHLY], colors.HexColor("#2563eb"), 2.8)
    draw_series([row.cost for row in MONTHLY], colors.HexColor("#f97316"), 2.8)
    draw_series([row.gross_profit for row in MONTHLY], colors.HexColor("#16a34a"), 2.8)

    for index, row in enumerate(MONTHLY):
        if index % 2 == 0 or index == len(MONTHLY) - 1:
            c.saveState()
            c.translate(px(index), y - 9)
            c.rotate(0)
            draw_right(c, row.month[2:], 8, 0, 7, colors.HexColor("#64748b"))
            c.restoreState()


def bar_chart(c: canvas.Canvas, x: float, y: float, w: float, rows: int = 5) -> None:
    visible_rows = TOP_DOCS[:rows]
    max_value = max(row.gross_profit for row in visible_rows)
    palette = [colors.HexColor("#7c3aed"), colors.HexColor("#0f766e"), colors.HexColor("#e11d48"), colors.HexColor("#2563eb")]
    row_h = 11 * mm
    gap = 5 * mm
    for index, row in enumerate(visible_rows):
        yy = y - index * (row_h + gap)
        draw_text(c, row.doc, x, yy + row_h + 2, 7.2, colors.HexColor("#334155"), True)
        rounded_rect(c, x, yy, w, row_h, colors.HexColor("#eef2ff"), radius=5)
        rounded_rect(c, x, yy, w * row.gross_profit / max_value, row_h, palette[index % len(palette)], radius=5)
        draw_right(c, rub(row.gross_profit), x + w - 4, yy + 4, 7.4, colors.white, True)


def operation_card(c: canvas.Canvas, operation: dict, x: float, y: float, w: float, h: float, accent) -> None:
    rounded_rect(c, x, y - h, w, h, colors.white, colors.HexColor("#e2e8f0"), 10)
    rounded_rect(c, x, y - 3 * mm, w, 3 * mm, accent, accent, 2)
    draw_text(c, operation["title"], x + 6 * mm, y - 14 * mm, 13.5, colors.HexColor("#0f172a"), True)
    draw_text(c, operation["subtitle"], x + 6 * mm, y - 22 * mm, 8.6, colors.HexColor("#64748b"))
    draw_text(c, operation["effect"], x + 6 * mm, y - 33 * mm, 9.7, accent, True)
    draw_text(c, operation["metrics"], x + 6 * mm, y - 41 * mm, 8.4, colors.HexColor("#334155"))

    draw_text(c, "Ключевые движения:", x + 6 * mm, y - 53 * mm, 9, colors.HexColor("#0f172a"), True)
    movement_y = y - 61 * mm
    for movement in operation["movements"]:
        c.setFillColor(accent)
        c.circle(x + 8 * mm, movement_y + 1.5, 1.5, fill=1, stroke=0)
        draw_text(c, movement, x + 12 * mm, movement_y, 8.4, colors.HexColor("#334155"))
        movement_y -= 7 * mm

    meaning_top = movement_y - 3 * mm
    draw_text(c, "Пояснение:", x + 6 * mm, meaning_top, 9, colors.HexColor("#0f172a"), True)
    draw_wrapped(c, operation["meaning"], x + 6 * mm, meaning_top - 6 * mm, w - 12 * mm, 8.5, colors.HexColor("#334155"), 10.4)


def draw_code_lines(c: canvas.Canvas, lines: list[str], x: float, y: float, w: float, line_height: float, size: float) -> float:
    c.setFont(FONT_CODE, size)
    for raw_line in lines:
        line = raw_line.replace("\t", "    ")
        wrapped = [line]
        if pdfmetrics.stringWidth(line, FONT_CODE, size) > w:
            chunks = []
            current = ""
            for part in line.split(" "):
                candidate = f"{current} {part}".rstrip() if current else part
                if pdfmetrics.stringWidth(candidate, FONT_CODE, size) > w and current:
                    chunks.append(current)
                    current = f"    {part}"
                else:
                    current = candidate
            if current:
                chunks.append(current)
            wrapped = chunks
        for wrapped_line in wrapped:
            color = colors.HexColor("#64748b") if wrapped_line.strip().startswith("//") else colors.HexColor("#0f172a")
            draw_text(c, wrapped_line, x, y, size, color)
            y -= line_height
    return y


def code_page(c: canvas.Canvas, snippet: dict, page_no: int, accent) -> None:
    draw_shell(c, "Кодовая опора отчета", snippet["title"], page_no)
    rounded_rect(c, 22 * mm, 44 * mm, 166 * mm, 164 * mm, colors.white, colors.HexColor("#e2e8f0"), 10)
    rounded_rect(c, 22 * mm, 205 * mm, 166 * mm, 3 * mm, accent, accent, 2)
    routine_bottom = draw_wrapped(c, snippet["routine"], 29 * mm, 194 * mm, 152 * mm, 10.5, colors.HexColor("#0f172a"), 12, True)
    source_y = routine_bottom - 4 * mm
    draw_wrapped(c, snippet["source"], 29 * mm, source_y, 152 * mm, 7.4, colors.HexColor("#64748b"), 8.6)
    draw_wrapped(c, snippet["comment"], 29 * mm, 176 * mm, 152 * mm, 8.8, colors.HexColor("#334155"), 10.8)

    rounded_rect(c, 29 * mm, 59 * mm, 152 * mm, 92 * mm, colors.HexColor("#f8fafc"), colors.HexColor("#cbd5e1"), 6)
    draw_code_lines(c, snippet["lines"], 34 * mm, 142 * mm, 142 * mm, 4.9 * mm, 6.6)
    c.showPage()


def first_page(c: canvas.Canvas) -> None:
    draw_shell(c, "Продажи и логика валовой прибыли", f"{CONTEXT['infobase']} · {CONTEXT['period']}", 1)
    margin = TOTALS["gross_profit"] / TOTALS["revenue"] * 100
    best_month = max(MONTHLY, key=lambda row: row.gross_profit)
    y = PAGE_H - 80 * mm
    metric_card(c, 22 * mm, y, "Выручка 90.01", short_rub(TOTALS["revenue"]), rub(TOTALS["revenue"]), colors.HexColor("#2563eb"))
    metric_card(c, 80 * mm, y, "Себестоимость 90.02", short_rub(TOTALS["cost"]), rub(TOTALS["cost"]), colors.HexColor("#f97316"))
    metric_card(c, 138 * mm, y, "Валовая прибыль", short_rub(TOTALS["gross_profit"]), f"Маржа {percent(margin)}", colors.HexColor("#16a34a"))

    rounded_rect(c, 22 * mm, 72 * mm, 166 * mm, 105 * mm, colors.white, colors.HexColor("#e2e8f0"), 10)
    draw_text(c, "Динамика по месяцам", 29 * mm, 165 * mm, 16, colors.HexColor("#0f172a"), True)
    draw_legend(c, 130 * mm, 166 * mm, colors.HexColor("#2563eb"), "Выручка")
    draw_legend(c, 153 * mm, 166 * mm, colors.HexColor("#f97316"), "Себестоимость")
    draw_legend(c, 178 * mm, 166 * mm, colors.HexColor("#16a34a"), "Прибыль")
    line_chart(c, 39 * mm, 94 * mm, 138 * mm, 58 * mm)

    draw_text(c, "Пиковый месяц по валовой прибыли:", 30 * mm, 83 * mm, 10, colors.HexColor("#0f172a"), True)
    draw_text(c, f"{best_month.month} · {rub(best_month.gross_profit)}", 30 * mm, 77 * mm, 10, colors.HexColor("#334155"))
    draw_text(c, "Проводок в расчете:", 105 * mm, 83 * mm, 10, colors.HexColor("#0f172a"), True)
    draw_text(c, f"{TOTALS['postings']:,}".replace(",", " ") + " по счетам 90.01 и 90.02", 105 * mm, 77 * mm, 10, colors.HexColor("#334155"))

    rounded_rect(c, 22 * mm, 32 * mm, 166 * mm, 29 * mm, colors.HexColor("#0f172a"), radius=10)
    draw_text(c, "Идея отчета", 29 * mm, 52 * mm, 14, colors.white, True)
    draw_wrapped(
        c,
        "Это демонстрационный управленческий отчет, который использует оба слоя: 1c-korp дает фактические проводки и обороты, а 1c-meta объясняет, почему именно эти обороты отражают бизнес-операции продаж, себестоимости, возвратов и закрытия месяца.",
        29 * mm,
        45 * mm,
        152 * mm,
        9.3,
        colors.HexColor("#e2e8f0"),
        12,
    )
    c.showPage()


def second_page(c: canvas.Canvas) -> None:
    draw_shell(c, "Как операции попадают в показатели", "Логика отражения бизнес-операций, установленная через 1c-meta", 2)
    rounded_rect(c, 22 * mm, 69 * mm, 166 * mm, 144 * mm, colors.white, colors.HexColor("#e2e8f0"), 10)
    draw_text(c, "Расчетная модель", 29 * mm, 200 * mm, 16, colors.HexColor("#0f172a"), True)
    palette = ["#2563eb", "#f97316", "#16a34a", "#7c3aed", "#e11d48", "#0891b2"]
    y = 185 * mm
    for index, point in enumerate(LOGIC_POINTS, start=1):
        c.setFillColor(colors.HexColor(palette[index - 1]))
        c.circle(34 * mm, y + 3, 6 * mm, fill=1, stroke=0)
        draw_right(c, str(index), 35.5 * mm, y, 10, colors.white, True)
        draw_wrapped(c, point, 43 * mm, y + 6, 135 * mm, 9.6, colors.HexColor("#334155"), 12)
        y -= 20 * mm

    rounded_rect(c, 22 * mm, 31 * mm, 166 * mm, 30 * mm, colors.HexColor("#fff7ed"), colors.HexColor("#fed7aa"), 10)
    draw_text(c, "Контроль возвратов и сторно", 29 * mm, 52 * mm, 14, colors.HexColor("#0f172a"), True)
    returns_text = (
        f"В найденных оборотах есть {RETURNS['buyer_returns_postings']} проводки документа "
        f"'Возврат товаров от покупателя' на {rub(RETURNS['buyer_returns_amount'])}, "
        f"{RETURNS['realization_adjustments_postings']} проводки корректировок реализации на "
        f"{rub(RETURNS['realization_adjustments_amount'])} и отрицательные движения на "
        f"{rub(RETURNS['negative_postings_amount'])}. Поэтому расчет построен по регистру "
        "с сохранением знаков, а не по списку документов реализации."
    )
    draw_wrapped(c, returns_text, 29 * mm, 45 * mm, 152 * mm, 9, colors.HexColor("#334155"), 11)
    c.showPage()


def third_page(c: canvas.Canvas) -> None:
    draw_shell(c, "Разрезы и проверочные следы", "Счета, документы и вклад закрытия месяца", 3)
    rounded_rect(c, 22 * mm, 166 * mm, 166 * mm, 50 * mm, colors.white, colors.HexColor("#e2e8f0"), 10)
    draw_text(c, "Счета, которые реально дали обороты", 29 * mm, 204 * mm, 15, colors.HexColor("#0f172a"), True)
    draw_text(c, "Счет", 29 * mm, 193 * mm, 8, colors.HexColor("#64748b"), True)
    draw_text(c, "Смысл", 52 * mm, 193 * mm, 8, colors.HexColor("#64748b"), True)
    draw_right(c, "Сумма", 158 * mm, 193 * mm, 8, colors.HexColor("#64748b"), True)
    draw_right(c, "Проводки", 181 * mm, 193 * mm, 8, colors.HexColor("#64748b"), True)
    y = 185 * mm
    for account, name, amount, postings in ACCOUNT_BREAKDOWN:
        draw_text(c, account, 29 * mm, y, 10, colors.HexColor("#0f172a"), True)
        draw_wrapped(c, name, 52 * mm, y + 2 * mm, 76 * mm, 8.4, colors.HexColor("#334155"), 9.6)
        draw_right(c, rub(amount), 158 * mm, y, 9.3, colors.HexColor("#334155"), True)
        draw_right(c, f"{postings:,}".replace(",", " "), 181 * mm, y, 9.3, colors.HexColor("#334155"), True)
        y -= 12 * mm

    rounded_rect(c, 22 * mm, 62 * mm, 166 * mm, 96 * mm, colors.white, colors.HexColor("#e2e8f0"), 10)
    draw_text(c, "Топ-5 положительных вкладов в валовую прибыль", 29 * mm, 146 * mm, 14, colors.HexColor("#0f172a"), True)
    bar_chart(c, 29 * mm, 127 * mm, 152 * mm, rows=5)

    rounded_rect(c, 22 * mm, 31 * mm, 166 * mm, 25 * mm, colors.HexColor("#eef2ff"), colors.HexColor("#c7d2fe"), 10)
    draw_wrapped(
        c,
        "Отдельно видны регламентные операции закрытия месяца: они могут не иметь выручки, но корректируют себестоимость и торговую наценку, поэтому меняют валовую прибыль. Это совпадает с логикой 1c-meta для отчета 'Анализ продаж'.",
        29 * mm,
        48 * mm,
        152 * mm,
        9.2,
        colors.HexColor("#334155"),
        11,
    )
    c.showPage()


def fourth_page(c: canvas.Canvas) -> None:
    draw_shell(c, "Пояснения по операциям", "Корректировка стоимости номенклатуры", 4)
    operation_card(c, OPERATION_EXPLANATIONS[0], 22 * mm, 215 * mm, 166 * mm, 150 * mm, colors.HexColor("#7c3aed"))
    c.showPage()


def fifth_page(c: canvas.Canvas) -> None:
    draw_shell(c, "Пояснения по операциям", "Реализация товаров и готовой продукции", 5)
    operation_card(c, OPERATION_EXPLANATIONS[1], 22 * mm, 215 * mm, 166 * mm, 150 * mm, colors.HexColor("#0f766e"))
    c.showPage()


def sixth_page(c: canvas.Canvas) -> None:
    draw_shell(c, "Пояснения по операциям", "Еще одна корректировка закрытия месяца", 6)
    operation_card(c, OPERATION_EXPLANATIONS[2], 22 * mm, 215 * mm, 166 * mm, 150 * mm, colors.HexColor("#e11d48"))
    c.showPage()


def seventh_page(c: canvas.Canvas) -> None:
    draw_shell(c, "Пояснения по операциям", "Услуга без себестоимости в 90.02", 7)
    operation_card(c, OPERATION_EXPLANATIONS[3], 22 * mm, 215 * mm, 166 * mm, 150 * mm, colors.HexColor("#2563eb"))
    c.showPage()


def eighth_page(c: canvas.Canvas) -> None:
    draw_shell(c, "Пояснения по операциям", "Реализация с выручкой и себестоимостью", 8)
    operation_card(c, OPERATION_EXPLANATIONS[4], 22 * mm, 215 * mm, 166 * mm, 150 * mm, colors.HexColor("#7c3aed"))
    c.showPage()


def ninth_page(c: canvas.Canvas) -> None:
    draw_shell(c, "Пояснения по операциям", "Общий вывод по логике отчета", 9)
    rounded_rect(c, 22 * mm, 42 * mm, 166 * mm, 72 * mm, colors.HexColor("#fff7ed"), colors.HexColor("#fed7aa"), 10)
    draw_text(c, "Что изменилось в отчете", 29 * mm, 100 * mm, 15, colors.HexColor("#0f172a"), True)
    draw_wrapped(
        c,
        "Теперь рейтинг операций не остается “немым”: рядом с каждой крупной строкой есть привязка к фактическим проводкам и бизнес-смыслу из 1c-meta. Для реализаций отчет показывает, как 62.01/90.01.1 формирует выручку, а 90.02.1/43 формирует себестоимость. Для регламентных операций видно, что закрытие месяца может изменить валовую прибыль без новой продажи, потому что оно уточняет себестоимость уже отраженных продаж или отгрузок.",
        29 * mm,
        90 * mm,
        152 * mm,
        9.4,
        colors.HexColor("#334155"),
        11.4,
    )
    c.showPage()


def code_pages(c: canvas.Canvas) -> None:
    palette = [
        colors.HexColor("#7c3aed"),
        colors.HexColor("#0f766e"),
        colors.HexColor("#e11d48"),
        colors.HexColor("#2563eb"),
    ]
    for index, snippet in enumerate(CODE_SNIPPETS):
        code_page(c, snippet, 10 + index, palette[index % len(palette)])


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    register_fonts()
    c = canvas.Canvas(str(PDF_PATH), pagesize=A4)
    c.setTitle("Продажи и логика валовой прибыли")
    first_page(c)
    second_page(c)
    third_page(c)
    fourth_page(c)
    fifth_page(c)
    sixth_page(c)
    seventh_page(c)
    eighth_page(c)
    ninth_page(c)
    code_pages(c)
    c.save()
    print(PDF_PATH)


if __name__ == "__main__":
    main()
