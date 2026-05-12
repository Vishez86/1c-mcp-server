// MCP_Tools.bsl
// ====================================================================
// Каталог MCP tools и их dispatcher.
// Содержит описания всех 17 read-only tools (name, title, description, inputSchema)
// и единую точку вызова MCP_Tools_Impl.
// ====================================================================

Функция СписокTools() Экспорт

	Результат = Новый Массив;

	Результат.Добавить(Tool_list_metadata_objects());
	Результат.Добавить(Tool_get_metadata_structure());
	Результат.Добавить(Tool_run_1c_query());
	Результат.Добавить(Tool_validate_1c_query());
	Результат.Добавить(Tool_get_object_by_ref());
	Результат.Добавить(Tool_find_object_by_id());
	Результат.Добавить(Tool_search_objects());
	Результат.Добавить(Tool_get_link_of_object());
	Результат.Добавить(Tool_find_references_to_object());
	Результат.Добавить(Tool_get_enum_values());
	Результат.Добавить(Tool_get_register_records());
	Результат.Добавить(Tool_get_document_movements());
	Результат.Добавить(Tool_list_reports());
	Результат.Добавить(Tool_get_report_info());
	Результат.Добавить(Tool_run_1c_report());
	Результат.Добавить(Tool_get_object_history());
	Результат.Добавить(Tool_get_current_user_context());

	Возврат Результат;

КонецФункции

// Главный dispatcher.
Функция Выполнить(ИмяТула, Аргументы) Экспорт

	CorrelationID = Строка(Новый УникальныйИдентификатор);

	Если НЕ MCP_Security.ToolРазрешен(ИмяТула) Тогда
		Возврат СформироватьОшибкуРезультата(
			MCP_Errors.Код_AccessDenied(),
			"Tool недоступен текущему пользователю.",
			Новый Структура("tool", ИмяТула),
			CorrelationID);
	КонецЕсли;

	Попытка
		Данные = Неопределено;

		Если ИмяТула = "list_metadata_objects" Тогда
			Данные = MCP_Tools_Impl.ListMetadataObjects(Аргументы);
		ИначеЕсли ИмяТула = "get_metadata_structure" Тогда
			Данные = MCP_Tools_Impl.GetMetadataStructure(Аргументы);
		ИначеЕсли ИмяТула = "run_1c_query" Тогда
			Данные = MCP_Tools_Impl.Run1CQuery(Аргументы);
		ИначеЕсли ИмяТула = "validate_1c_query" Тогда
			Данные = MCP_Tools_Impl.Validate1CQuery(Аргументы);
		ИначеЕсли ИмяТула = "get_object_by_ref" Тогда
			Данные = MCP_Tools_Impl.GetObjectByRef(Аргументы);
		ИначеЕсли ИмяТула = "find_object_by_id" Тогда
			Данные = MCP_Tools_Impl.FindObjectByID(Аргументы);
		ИначеЕсли ИмяТула = "search_objects" Тогда
			Данные = MCP_Tools_Impl.SearchObjects(Аргументы);
		ИначеЕсли ИмяТула = "get_link_of_object" Тогда
			Данные = MCP_Tools_Impl.GetLinkOfObject(Аргументы);
		ИначеЕсли ИмяТула = "find_references_to_object" Тогда
			Данные = MCP_Tools_Impl.FindReferencesToObject(Аргументы);
		ИначеЕсли ИмяТула = "get_enum_values" Тогда
			Данные = MCP_Tools_Impl.GetEnumValues(Аргументы);
		ИначеЕсли ИмяТула = "get_register_records" Тогда
			Данные = MCP_Tools_Impl.GetRegisterRecords(Аргументы);
		ИначеЕсли ИмяТула = "get_document_movements" Тогда
			Данные = MCP_Tools_Impl.GetDocumentMovements(Аргументы);
		ИначеЕсли ИмяТула = "list_reports" Тогда
			Данные = MCP_Tools_Impl.ListReports(Аргументы);
		ИначеЕсли ИмяТула = "get_report_info" Тогда
			Данные = MCP_Tools_Impl.GetReportInfo(Аргументы);
		ИначеЕсли ИмяТула = "run_1c_report" Тогда
			Данные = MCP_Tools_Impl.Run1CReport(Аргументы);
		ИначеЕсли ИмяТула = "get_object_history" Тогда
			Данные = MCP_Tools_Impl.GetObjectHistory(Аргументы);
		ИначеЕсли ИмяТула = "get_current_user_context" Тогда
			Данные = MCP_Tools_Impl.GetCurrentUserContext(Аргументы);
		Иначе
			Возврат СформироватьОшибкуРезультата(
				MCP_Errors.Код_UnknownTool(),
				"Unknown tool: " + ИмяТула,
				Новый Структура("tool", ИмяТула),
				CorrelationID);
		КонецЕсли;

		// Импл-функции должны возвращать Структуру. Если кто-то вернул иное —
		// конвертируем в пустую структуру, чтобы Данные.Вставить ниже не упало.
		Если ТипЗнч(Данные) <> Тип("Структура") Тогда
			Данные = Новый Структура;
		КонецЕсли;
		Данные.Вставить("ok", Истина);
		ПроверитьРазмерРезультата(Данные);
		БезопасноЗаписатьАудитУспеха(CorrelationID, ИмяТула, Аргументы, Данные);
		Возврат СформироватьУспешныйРезультат(Данные);

	Исключение
		ТекстИскл = ОписаниеОшибки();
		Ошибка = MCP_Errors.РазобратьИсключение(ТекстИскл, CorrelationID);
		БезопасноЗаписатьАудитОшибки(CorrelationID, ИмяТула, Аргументы, Ошибка);
		Возврат СформироватьОшибкуРезультата(Ошибка.code, Ошибка.message, Ошибка.details, CorrelationID);
	КонецПопытки;

КонецФункции

// ---- Сериализация tool result -------------------------------------

Функция СформироватьУспешныйРезультат(Данные) Экспорт

	Контент = Новый Массив;
	Блок = Новый Структура;
	Блок.Вставить("type", "text");
	Блок.Вставить("text", MCP_JSONRPC.СохранитьJSON(Данные));
	Контент.Добавить(Блок);

	Результат = Новый Структура;
	Результат.Вставить("content", Контент);
	Результат.Вставить("structuredContent", Данные);
	Результат.Вставить("isError", Ложь);
	Возврат Результат;

КонецФункции

Функция СформироватьОшибкуРезультата(Код, Сообщение, Детали, CorrelationID) Экспорт

	Данные = Новый Структура;
	Данные.Вставить("ok", Ложь);

	Ошибка = Новый Структура;
	Ошибка.Вставить("code", Код);
	Ошибка.Вставить("message", Сообщение);
	Ошибка.Вставить("details", ?(Детали = Неопределено, Новый Структура, Детали));
	Ошибка.Вставить("correlation_id", CorrelationID);
	Данные.Вставить("error", Ошибка);

	Контент = Новый Массив;
	Блок = Новый Структура;
	Блок.Вставить("type", "text");
	Блок.Вставить("text", "Ошибка: " + Код + ". " + Сообщение);
	Контент.Добавить(Блок);

	Результат = Новый Структура;
	Результат.Вставить("content", Контент);
	Результат.Вставить("structuredContent", Данные);
	Результат.Вставить("isError", Истина);
	Возврат Результат;

КонецФункции

// Аудит — best-effort. Любой сбой (журнал, сериализация JSON и т.п.) не должен
// конвертировать успешный tool-вызов в ошибку или прятать оригинальную ошибку tool'а
// под "audit failed".
Процедура БезопасноЗаписатьАудитУспеха(CorrelationID, ИмяТула, Аргументы, Данные)
	Попытка
		MCP_Audit.ЗаписатьУспех(CorrelationID, ИмяТула, Аргументы, Данные);
	Исключение
		Попытка
			ЗаписьЖурналаРегистрации("MCP.audit.failed",
				УровеньЖурналаРегистрации.Предупреждение, , , ОписаниеОшибки());
		Исключение
		КонецПопытки;
	КонецПопытки;
КонецПроцедуры

Процедура БезопасноЗаписатьАудитОшибки(CorrelationID, ИмяТула, Аргументы, Ошибка)
	Попытка
		MCP_Audit.ЗаписатьОшибку(CorrelationID, ИмяТула, Аргументы, Ошибка);
	Исключение
		Попытка
			ЗаписьЖурналаРегистрации("MCP.audit.failed",
				УровеньЖурналаРегистрации.Предупреждение, , , ОписаниеОшибки());
		Исключение
		КонецПопытки;
	КонецПопытки;
КонецПроцедуры

Процедура ПроверитьРазмерРезультата(Данные)

	МаксРазмер = MCP_Config.Лимиты().max_result_json_bytes;
	Если МаксРазмер = Неопределено ИЛИ МаксРазмер <= 0 Тогда
		Возврат;
	КонецЕсли;

	ТекстДанных = MCP_JSONRPC.СохранитьJSON(Данные);
	ФактическийРазмер = СтрДлина(ТекстДанных);
	Если ФактическийРазмер > МаксРазмер Тогда
		Детали = Новый Структура;
		Детали.Вставить("max_result_json_bytes", МаксРазмер);
		Детали.Вставить("actual_chars", ФактическийРазмер);
		MCP_Errors.ВозбудитьОшибку(MCP_Errors.Код_ResultTooLarge(),
			"Результат превышает max_result_json_bytes.", Детали);
	КонецЕсли;

КонецПроцедуры

// ====================================================================
// Описания tools для tools/list
// ====================================================================

Функция Tool_list_metadata_objects()
	Props = Новый Структура;
	Props.Вставить("kinds", _Схема("array", , "Фильтр по видам метаданных."));
	Props.Вставить("query", _Схема("string", , "Поиск по имени/синониму/комментарию."));
	Props.Вставить("include_not_allowed", _Схема("boolean", , "Только для MCP-admin."));
	Props.Вставить("include_details", _Схема("boolean", , "Доп. детали."));
	Props.Вставить("limit", _СхемаInt(1, 1000, 200));
	Props.Вставить("cursor", _Схема("string", , "Cursor пагинации."));
	Возврат _Tool("list_metadata_objects",
		"Получить список объектов метаданных 1С",
		"Discovery tool. Список справочников, документов, регистров и прочих доступных объектов.",
		Props);
КонецФункции

Функция Tool_get_metadata_structure()
	Props = Новый Структура;
	Props.Вставить("type", _Схема("string", , "Полное имя: Справочник.Контрагенты"));
	Props.Вставить("include_standard_attributes", _Схема("boolean"));
	Props.Вставить("include_tabular_sections", _Схема("boolean"));
	Props.Вставить("include_forms", _Схема("boolean"));
	Props.Вставить("include_commands", _Схема("boolean"));
	Props.Вставить("include_query_names", _Схема("boolean"));
	Props.Вставить("include_sensitive_flags", _Схема("boolean"));
	Возврат _Tool("get_metadata_structure",
		"Получить структуру объекта метаданных",
		"Реквизиты, табличные части, измерения/ресурсы регистров и query names.",
		Props, _Required("type"));
КонецФункции

Функция Tool_run_1c_query()
	Props = Новый Структура;
	Props.Вставить("query", _Схема("string", , "Текст read-only запроса 1С."));
	Props.Вставить("parameters", _СхемаОбъект());
	Props.Вставить("limit", _СхемаInt(1, 1000, 100));
	Props.Вставить("cursor", _Схема("string", , "Offset cursor для следующей страницы строк."));
	Props.Вставить("timeout_seconds", _СхемаInt(1, 60, 15));
	Props.Вставить("validate_before_run", _Схема("boolean"));
	Props.Вставить("return_format", _СхемаЕnum(СписокСтрок("rows,table")));
	Props.Вставить("include_column_types", _Схема("boolean"));
	Возврат _Tool("run_1c_query",
		"Выполнить безопасный read-only запрос 1С",
		"Запрос на языке запросов 1С с параметрами. Самый мощный read-only tool.",
		Props, _Required("query"));
КонецФункции

Функция Tool_validate_1c_query()
	Props = Новый Структура;
	Props.Вставить("query", _Схема("string"));
	Props.Вставить("parameters", _СхемаОбъект());
	Props.Вставить("strict", _Схема("boolean"));
	Props.Вставить("explain", _Схема("boolean"));
	Возврат _Tool("validate_1c_query",
		"Проверить запрос 1С до выполнения",
		"Проверка синтаксиса, объектов, параметров и рисков до run_1c_query.",
		Props, _Required("query"));
КонецФункции

Функция Tool_get_object_by_ref()
	Props = Новый Структура;
	Props.Вставить("type", _Схема("string"));
	Props.Вставить("uuid", _Схема("string"));
	Props.Вставить("fields", _Схема("array"));
	Props.Вставить("include_standard_fields", _Схема("boolean"));
	Props.Вставить("include_tabular_sections", _Схема("boolean"));
	Props.Вставить("tabular_sections", _Схема("array"));
	Props.Вставить("tabular_section_row_limit", _СхемаInt(1, 1000, 100));
	Props.Вставить("tabular_section_cursor", _Схема("string", , "Offset cursor строк табличных частей."));
	Props.Вставить("include_navigation_url", _Схема("boolean"));
	Возврат _Tool("get_object_by_ref",
		"Получить объект по типу и UUID ссылки",
		"Точное получение ссылочного объекта по полному имени типа и UUID.",
		Props, _Required("type", "uuid"));
КонецФункции

Функция Tool_find_object_by_id()
	Props = Новый Структура;
	Props.Вставить("uuid", _Схема("string"));
	Props.Вставить("types", _Схема("array"));
	Props.Вставить("kinds", _Схема("array"));
	Props.Вставить("limit", _СхемаInt(1, 100, 10));
	Props.Вставить("cursor", _Схема("string", , "Offset cursor по проверяемым типам."));
	Props.Вставить("include_deleted", _Схема("boolean"));
	Возврат _Tool("find_object_by_id",
		"Найти объект по UUID без знания типа",
		"Перебор разрешённых ссылочных типов по UUID.",
		Props, _Required("uuid"));
КонецФункции

Функция Tool_search_objects()
	Props = Новый Структура;
	Props.Вставить("query", _Схема("string"));
	Props.Вставить("types", _Схема("array"));
	Props.Вставить("kinds", _Схема("array"));
	Props.Вставить("search_fields", _Схема("array"));
	Props.Вставить("filters", _СхемаОбъект());
	Props.Вставить("date_from", _Схема("string"));
	Props.Вставить("date_to", _Схема("string"));
	Props.Вставить("limit", _СхемаInt(1, 100, 20));
	Props.Вставить("cursor", _Схема("string", , "Offset cursor по найденным объектам."));
	Props.Вставить("include_deleted", _Схема("boolean"));
	Props.Вставить("include_fields", _Схема("array"));
	Props.Вставить("match_mode", _СхемаЕnum(СписокСтрок("auto,exact,prefix,contains")));
	Возврат _Tool("search_objects",
		"Поиск объектов по строке, коду, номеру, ИНН, артикулу",
		"Human-friendly поиск по разрешённым полям.",
		Props, _Required("query"));
КонецФункции

Функция Tool_get_link_of_object()
	Props = Новый Структура;
	Props.Вставить("type", _Схема("string"));
	Props.Вставить("uuid", _Схема("string"));
	Props.Вставить("link_type", _СхемаЕnum(СписокСтрок("auto,e1cib,web_client,thin_client")));
	Props.Вставить("base_url", _Схема("string"));
	Props.Вставить("include_presentation", _Схема("boolean"));
	Возврат _Tool("get_link_of_object",
		"Получить навигационную ссылку на объект",
		"Возвращает e1cib/web-client/thin-client ссылки на объект 1С.",
		Props, _Required("type", "uuid"));
КонецФункции

Функция Tool_find_references_to_object()
	Props = Новый Структура;
	TargetProps = Новый Структура;
	TargetProps.Вставить("type", _Схема("string"));
	TargetProps.Вставить("uuid", _Схема("string"));
	Target = Новый Структура;
	Target.Вставить("type", "object");
	Target.Вставить("properties", TargetProps);
	Target.Вставить("required", _МассивСтрок("type,uuid"));
	Props.Вставить("target", Target);

	Props.Вставить("search_in_types", _Схема("array"));
	Props.Вставить("search_in_kinds", _Схема("array"));
	Props.Вставить("period_from", _Схема("string"));
	Props.Вставить("period_to", _Схема("string"));
	Props.Вставить("limit_per_type", _СхемаInt(1, 100, 20));
	Props.Вставить("max_types", _СхемаInt(1, 200, 50));
	Props.Вставить("cursor", _Схема("string", , "Offset cursor по группам ссылок."));
	Props.Вставить("include_counts", _Схема("boolean"));
	Props.Вставить("include_samples", _Схема("boolean"));
	Возврат _Tool("find_references_to_object",
		"Найти ссылки на объект",
		"Поиск документов, справочников, регистров, ссылающихся на target.",
		Props, _Required("target"));
КонецФункции

Функция Tool_get_enum_values()
	Props = Новый Структура;
	Props.Вставить("type", _Схема("string"));
	Props.Вставить("include_order", _Схема("boolean"));
	Props.Вставить("include_empty", _Схема("boolean"));
	Props.Вставить("limit", _СхемаInt(1, 1000, 1000));
	Props.Вставить("cursor", _Схема("string", , "Offset cursor значений перечисления."));
	Возврат _Tool("get_enum_values",
		"Получить значения перечисления",
		"Возвращает значения Перечисление.*",
		Props, _Required("type"));
КонецФункции

Функция Tool_get_register_records()
	Props = Новый Структура;
	Props.Вставить("register_type", _СхемаЕnum(СписокСтрок("РегистрСведений,РегистрНакопления,РегистрБухгалтерии,РегистрРасчета")));
	Props.Вставить("register", _Схема("string"));
	Props.Вставить("mode", _СхемаЕnum(СписокСтрок("records,slice_first,slice_last,balance,turnovers,balance_and_turnovers")));
	Props.Вставить("period", _Схема("string"));
	Props.Вставить("period_from", _Схема("string"));
	Props.Вставить("period_to", _Схема("string"));
	Props.Вставить("filters", _СхемаОбъект());
	Props.Вставить("dimensions", _Схема("array"));
	Props.Вставить("resources", _Схема("array"));
	Props.Вставить("attributes", _Схема("array"));
	Props.Вставить("order_by", _Схема("array"));
	Props.Вставить("limit", _СхемаInt(1, 1000, 100));
	Props.Вставить("cursor", _Схема("string", , "Offset cursor записей регистра."));
	Возврат _Tool("get_register_records",
		"Получить записи, срезы, остатки и обороты регистров",
		"Универсальный tool для чтения регистров любого вида.",
		Props, _Required("register_type", "register", "mode"));
КонецФункции

Функция Tool_get_document_movements()
	Props = Новый Структура;
	Props.Вставить("document_type", _Схема("string"));
	Props.Вставить("uuid", _Схема("string"));
	Props.Вставить("registers", _Схема("array"));
	Props.Вставить("include_empty_registers", _Схема("boolean"));
	Props.Вставить("include_totals_effect", _Схема("boolean"));
	Props.Вставить("row_limit_per_register", _СхемаInt(1, 1000, 200));
	Props.Вставить("cursor", _Схема("string", , "Offset cursor списка регистров."));
	Props.Вставить("row_cursor", _Схема("string", , "Offset cursor строк в каждом регистре."));
	Возврат _Tool("get_document_movements",
		"Получить движения документа по регистрам",
		"Записи регистров, сформированные документом-регистратором.",
		Props, _Required("document_type", "uuid"));
КонецФункции

Функция Tool_list_reports()
	Props = Новый Структура;
	Props.Вставить("query", _Схема("string"));
	Props.Вставить("include_variants", _Схема("boolean"));
	Props.Вставить("include_not_allowed", _Схема("boolean"));
	Props.Вставить("limit", _СхемаInt(1, 500, 100));
	Props.Вставить("cursor", _Схема("string"));
	Возврат _Tool("list_reports",
		"Получить список доступных отчётов",
		"Discovery tool для отчётов.",
		Props);
КонецФункции

Функция Tool_get_report_info()
	Props = Новый Структура;
	Props.Вставить("report", _Схема("string"));
	Props.Вставить("variant", _Схема("string"));
	Props.Вставить("include_schema", _Схема("boolean"));
	Props.Вставить("include_variants", _Схема("boolean"));
	Props.Вставить("include_default_settings", _Схема("boolean"));
	Возврат _Tool("get_report_info",
		"Получить параметры и структуру отчёта",
		"Параметры, варианты, default settings и подсказки запуска.",
		Props, _Required("report"));
КонецФункции

Функция Tool_run_1c_report()
	Props = Новый Структура;
	Props.Вставить("report", _Схема("string"));
	Props.Вставить("variant", _Схема("string"));
	Props.Вставить("parameters", _СхемаОбъект());
	Props.Вставить("output_format", _СхемаЕnum(СписокСтрок("table,json,text")));
	Props.Вставить("limit", _СхемаInt(1, 5000, 1000));
	Props.Вставить("cursor", _Схема("string", , "Offset cursor строк отчёта."));
	Props.Вставить("timeout_seconds", _СхемаInt(1, 180, 60));
	Props.Вставить("include_totals", _Схема("boolean"));
	Возврат _Tool("run_1c_report",
		"Выполнить отчёт 1С",
		"Выполняет разрешённый отчёт через СКД и возвращает результат.",
		Props, _Required("report"));
КонецФункции

Функция Tool_get_object_history()
	Props = Новый Структура;
	TargetProps = Новый Структура;
	TargetProps.Вставить("type", _Схема("string"));
	TargetProps.Вставить("uuid", _Схема("string"));
	Target = Новый Структура;
	Target.Вставить("type", "object");
	Target.Вставить("properties", TargetProps);
	Target.Вставить("required", _МассивСтрок("type,uuid"));
	Props.Вставить("target", Target);

	Props.Вставить("mode", _СхемаЕnum(СписокСтрок("auto,versions,event_log,status_changes")));
	Props.Вставить("period_from", _Схема("string"));
	Props.Вставить("period_to", _Схема("string"));
	Props.Вставить("include_diff", _Схема("boolean"));
	Props.Вставить("limit", _СхемаInt(1, 500, 100));
	Props.Вставить("cursor", _Схема("string", , "Offset cursor событий истории."));
	Возврат _Tool("get_object_history",
		"Получить историю объекта, версии или события журнала",
		"Версии объекта, журнал регистрации, регистры истории статусов.",
		Props, _Required("target"));
КонецФункции

Функция Tool_get_current_user_context()
	Props = Новый Структура;
	Props.Вставить("include_roles", _Схема("boolean"));
	Props.Вставить("include_limits", _Схема("boolean"));
	Props.Вставить("include_allowed_metadata_summary", _Схема("boolean"));
	Props.Вставить("include_server_info", _Схема("boolean"));
	Возврат _Tool("get_current_user_context",
		"Получить текущий контекст пользователя и базы",
		"Пользователь, роли, база, версия конфигурации и MCP-сервера, лимиты.",
		Props);
КонецФункции

// ---- Schema helpers ---------------------------------------------

Функция _Tool(Имя, Title, Описание, Properties, Required = Неопределено)

	ВходнаяСхема = Новый Структура;
	ВходнаяСхема.Вставить("type", "object");
	ВходнаяСхема.Вставить("properties", Properties);
	ВходнаяСхема.Вставить("additionalProperties", Ложь);
	Если Required <> Неопределено Тогда
		ВходнаяСхема.Вставить("required", Required);
	КонецЕсли;

	Tool = Новый Структура;
	Tool.Вставить("name", Имя);
	Tool.Вставить("title", Title);
	Tool.Вставить("description", Описание);
	Tool.Вставить("inputSchema", ВходнаяСхема);
	Возврат Tool;

КонецФункции

Функция _Схема(Тип, Items = Неопределено, Описание = "")
	Стр = Новый Структура;
	Стр.Вставить("type", Тип);
	Если Items <> Неопределено Тогда
		Стр.Вставить("items", Items);
	ИначеЕсли Тип = "array" Тогда
		Item = Новый Структура("type", "string");
		Стр.Вставить("items", Item);
	КонецЕсли;
	Если НЕ ПустаяСтрока(Описание) Тогда
		Стр.Вставить("description", Описание);
	КонецЕсли;
	Возврат Стр;
КонецФункции

Функция _СхемаInt(Мин, Макс, ПоУмолчанию)
	Стр = Новый Структура;
	Стр.Вставить("type", "integer");
	Стр.Вставить("minimum", Мин);
	Стр.Вставить("maximum", Макс);
	Стр.Вставить("default", ПоУмолчанию);
	Возврат Стр;
КонецФункции

Функция _СхемаЕnum(Знач Список)
	Стр = Новый Структура;
	Стр.Вставить("type", "string");
	Стр.Вставить("enum", Список);
	Возврат Стр;
КонецФункции

Функция _СхемаОбъект()
	Стр = Новый Структура;
	Стр.Вставить("type", "object");
	Возврат Стр;
КонецФункции

Функция _Required(Знач П1, Знач П2 = "", Знач П3 = "")
	М = Новый Массив;
	М.Добавить(П1);
	Если НЕ ПустаяСтрока(П2) Тогда
		М.Добавить(П2);
	КонецЕсли;
	Если НЕ ПустаяСтрока(П3) Тогда
		М.Добавить(П3);
	КонецЕсли;
	Возврат М;
КонецФункции

Функция _МассивСтрок(Знач СтрокаЧерезЗапятую)
	Возврат СтрРазделить(СтрокаЧерезЗапятую, ",", Ложь);
КонецФункции

Функция СписокСтрок(Знач Текст)
	Возврат СтрРазделить(Текст, ",", Ложь);
КонецФункции
