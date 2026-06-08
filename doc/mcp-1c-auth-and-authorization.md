# Аутентификация и разграничение прав для MCP-сервера на 1С

Ниже — правильная целевая схема. Главная мысль: **ChatGPT/Claude не должны логиниться в 1С по LDAP/паролю и не должны ходить под общей сервисной учеткой 1С**. Они должны проходить **OAuth 2.1/OIDC**, а ваш MCP-сервер должен превращать проверенную внешнюю идентичность в **конкретного пользователя 1С** и уже через него применять права.

## 1. Рекомендуемая архитектура

```text
ChatGPT / Claude Desktop
        |
        | HTTPS MCP + Authorization: Bearer <access_token>
        v
[Auth Gateway / MCP Resource Server]
        |
        | validate JWT/introspection, map external user -> 1C user
        v
[1C MCP server / 1C application logic]
        |
        | execute as effective 1C user or enforce 1C-user policy
        v
[1C infobase roles, RLS, business rules]
```

Для удалённого MCP по HTTP актуальная спецификация MCP ожидает OAuth-style модель: MCP-сервер выступает как OAuth resource server, MCP-клиент — как OAuth client, а authorization server выпускает access token для конкретного пользователя и конкретного MCP resource. MCP-сервер обязан публиковать protected resource metadata и валидировать, что токен выпущен именно для него как audience/resource.

Для ChatGPT это тоже ожидаемый путь: OpenAI пишет, что authenticated MCP server должен реализовать OAuth 2.1 flow по MCP authorization spec; ChatGPT поддерживает CIMD, DCR, predefined OAuth clients и PKCE, а после OAuth-flow отправляет `Authorization: Bearer …` к вашему MCP-серверу.

Для Claude Desktop важно не ошибиться в сетевой модели: custom connector с remote MCP, даже в Claude Desktop, подключается к вашему MCP-серверу **из облачной инфраструктуры Anthropic**, а не напрямую с ноутбука пользователя. Поэтому ваш HTTPS MCP endpoint и ваш authorization server должны быть доступны снаружи/из разрешённых egress-диапазонов.

## 2. Что делать с вашим LDAP/IdP

LDAP лучше оставить источником пользователей/групп, но наружу для MCP надо выставлять **OAuth 2.1/OIDC authorization server**. Практически это может быть Keycloak, AD FS, Entra ID, Okta/Auth0, Ping, Authelia и т.п. Если у вас сейчас “LDAP” — поставьте IdP/authorization server, который федеративно подключается к LDAP/AD и выпускает OIDC/OAuth tokens.

Например, Keycloak официально поддерживает OpenID Connect, OAuth 2.0 и SAML, а также может работать с LDAP/Active Directory как с внешним хранилищем пользователей/учётных данных.

В 1С при этом желательно настроить пользователей так, чтобы у них был стабильный внешний идентификатор из IdP. 1С поддерживает OpenID Connect-аутентификацию для тонкого, веб- и мобильного клиента; 1С описывает, что OIDC позволяет 1С проверять личность пользователя на основании аутентификации сторонним провайдером. Но для MCP HTTP API этого недостаточно само по себе: MCP-запросы приходят как bearer-token resource requests, и ваш MCP/resource-server всё равно должен проверять access token на каждом запросе.

## 3. Как должен выглядеть OAuth/MCP flow

Минимально:

1. MCP endpoint:

   ```text
   https://mcp.company.ru/mcp
   ```

2. Protected resource metadata:

   ```text
   https://mcp.company.ru/.well-known/oauth-protected-resource
   ```

   Пример:

   ```json
   {
     "resource": "https://mcp.company.ru/mcp",
     "authorization_servers": ["https://idp.company.ru/realms/mcp"],
     "scopes_supported": [
       "mcp.1c.read",
       "mcp.1c.write",
       "mcp.1c.admin"
     ],
     "resource_documentation": "https://mcp.company.ru/docs"
   }
   ```

3. При неаутентифицированном запросе MCP-сервер возвращает:

   ```http
   HTTP/1.1 401 Unauthorized
   WWW-Authenticate: Bearer resource_metadata="https://mcp.company.ru/.well-known/oauth-protected-resource",
                     scope="mcp.1c.read"
   ```

   Такой `401` + `WWW-Authenticate` — ключевой механизм, по которому MCP-клиенты находят authorization server и понимают нужные scopes.

4. IdP публикует discovery metadata:

   ```text
   https://idp.company.ru/.well-known/oauth-authorization-server
   или
   https://idp.company.ru/.well-known/openid-configuration
   ```

5. ChatGPT/Claude отправляют пользователя в authorization-code + PKCE flow.

6. IdP выпускает access token, где должны быть как минимум:

   ```json
   {
     "iss": "https://idp.company.ru/realms/mcp",
     "sub": "stable-user-id",
     "aud": "https://mcp.company.ru/mcp",
     "scope": "mcp.1c.read mcp.1c.write",
     "exp": 1760000000,
     "iat": 1759996400,
     "client_id": "chatgpt-or-claude-client"
   }
   ```

7. MCP-сервер на каждый запрос проверяет:

   ```text
   iss, подпись/JWKS, exp, nbf, aud или resource, scope, client_id/azp, tenant, состояние пользователя, маппинг на пользователя 1С.
   ```

MCP-клиент обязан отправлять токен в HTTP header `Authorization: Bearer <access-token>`, а не в query string; MCP-сервер обязан валидировать, что токен выпущен именно для него.

## 4. Как маппить внешнего пользователя на пользователя 1С

Сделайте в 1С отдельный регистр/справочник соответствий, например:

| Поле | Назначение |
|---|---|
| `issuer` | `https://idp.company.ru/realms/mcp` |
| `external_subject` | стабильный `sub` из IdP |
| `external_upn` | UPN/login для удобства |
| `external_object_id` | AD objectGUID / Entra objectId, если есть |
| `user_1c` | ссылка на пользователя информационной базы 1С |
| `enabled` | разрешён ли доступ через MCP |
| `allowed_scopes_override` | опционально |
| `last_seen_at` | аудит |
| `created_by / approved_by` | кто привязал |

Лучший ключ — **стабильный неизменяемый идентификатор**: OIDC `sub`, AD `objectGUID`, Entra `oid`. Не делайте основным ключом email или ФИО: они меняются и иногда переиспользуются. Email/UPN можно хранить как отображаемый атрибут.

Если маппинга нет — возвращайте `403 Forbidden`, а не создавайте пользователя автоматически с какими-либо правами. Автопровижининг допустим только в минимальную роль “нет доступа / заявка на доступ”.

## 5. Где проводить разграничение прав

Разграничение должно быть двухуровневым.

**Уровень OAuth scopes** — грубый периметр MCP:

```text
mcp.1c.read          читать данные
mcp.1c.write         выполнять безопасные изменения
mcp.1c.destructive   удаление/проведение/отмена проведения
mcp.1c.admin         административные операции
```

Эти scopes решают, какие MCP tools вообще доступны.

**Уровень 1С** — финальное бизнес-разграничение:

```text
какие организации доступны
какие склады доступны
какие документы можно читать
какие документы можно создавать
можно ли проводить/отменять/удалять
RLS / роли / прикладные проверки
```

Не пытайтесь полностью перенести все роли 1С в OAuth token. Token должен говорить: “это аутентифицированный пользователь X, с такими coarse scopes”. А 1С должна сказать: “пользователь 1С Y имеет/не имеет право на эту конкретную операцию”.

## 5.1. Как 1С сообщает LLM об отказе прав

Каждый tool-result содержит `auth_context` с текущим пользователем 1С, базой, версией конфигурации, `identity_key` и `cache_policy.cacheable=false`. Это нужно именно для схемы с per-session proxy: после перелогина LLM обязана заново выполнять discovery и не использовать сведения о правах предыдущей учетной записи.

Если 1С отказала в доступе к данным, отчету, регистру, объекту или журналу регистрации, MCP-сервер возвращает прикладную ошибку tool:

```json
{
  "isError": true,
  "structuredContent": {
    "ok": false,
    "authorization": {
      "reason_code": "1c_access_denied",
      "denied_operation": "query_execute",
      "retry_policy": "do_not_retry_same_request_without_reauth_or_permission_change"
    },
    "error": {
      "code": "access_denied",
      "message": "Недостаточно прав текущей учетной записи 1С."
    }
  }
}
```

`reason_code=mcp_type_not_allowed`, `mcp_field_not_allowed` или `mcp_tool_not_allowed` означает отказ политики MCP/allowlist, а не платформенных ролей 1С. В обоих случаях агент должен объяснить пользователю ограничение и не повторять тот же запрос без перелогина или выдачи прав.

Важно для промежуточного `py_server`: если клиент умеет читать structured output, желательно проксировать `structuredContent` без потерь и использовать `response.tool_result_mode=structured_only` или `both`. Для клиентов, которые передают модели только текстовый content, используйте `response.tool_result_mode=text_only`; тогда критичная диагностика возвращается JSON-строкой в `content[]`. В режиме `both` сервер дополнительно дублирует диагностику в `content[]` строкой `Диагностика JSON: ...`.

## 6. Важный нюанс: “выполнять от имени пользователя 1С”

Тут нужно быть очень аккуратными.

Если вы хотите, чтобы **платформенные роли, RLS и проверки 1С сработали нативно**, код должен реально выполняться в сеансе 1С, где текущий пользователь информационной базы — именно целевой пользователь 1С. Просто передать в модуль переменную `ЭффективныйПользователь = Иванов` — это не то же самое, что сеанс под Ивановым.

Поэтому есть три варианта.

### Вариант A — лучший, если технически реализуем

Ваш MCP/resource-server после проверки OAuth создаёт/использует сеанс 1С под соответствующим пользователем 1С, и 1С сама применяет его роли/RLS.

Плюс: честное “от имени пользователя”.  
Минус: надо проверить, позволяет ли ваша конкретная схема публикации/HTTP-сервиса 1С создать такой сеанс без хранения пароля пользователя.

### Вариант B — gateway проверяет OAuth, 1С выполняет через прикладной policy layer

MCP gateway валидирует token, определяет пользователя 1С и передаёт в 1С подписанный контекст:

```json
{
  "external_sub": "...",
  "user_1c_uuid": "...",
  "scopes": ["mcp.1c.read"],
  "request_id": "..."
}
```

В 1С все MCP-операции идут через общий модуль/сервис, который явно проверяет права для `user_1c_uuid`.

Плюс: проще внедрить.  
Минус: это уже не нативное платформенное выполнение “под пользователем”; надо очень дисциплинированно реализовать прикладные проверки, иначе можно обойти права.

### Вариант C — технический пользователь 1С с полными правами

Это допустимо только как внутренний сервисный механизм, если поверх него есть строгий и протестированный policy layer. Но как самостоятельная схема — плохой вариант. Если ChatGPT/Claude получают доступ к сервисной учётке с широкими правами, то ошибка в одном tool может стать полным обходом прав 1С.

Моя рекомендация: **A, если возможно; иначе B, но с запретом прямых универсальных запросов и с очень жёстким audit/policy layer**.

## 7. Как защищать связку “gateway → 1С”

Если OAuth validation делаете не внутри 1С, а на reverse proxy/API gateway, то нельзя просто пробрасывать заголовок:

```http
X-User: ivanov
```

Такой заголовок легко подделать, если кто-то обойдёт proxy.

Нужно:

```text
Internet
  -> WAF / API Gateway / OAuth Resource Server
  -> private network / mTLS
  -> 1C MCP endpoint
```

И одно из:

```text
1. 1С endpoint доступен только с gateway IP + mTLS;
2. gateway подписывает identity context JWS/HMAC;
3. 1С проверяет подпись, timestamp, nonce, request_id;
4. прямой доступ к 1С MCP endpoint из интернета закрыт.
```

Для ChatGPT дополнительно можно использовать mTLS: OpenAI указывает, что ChatGPT предъявляет OpenAI-managed client certificate при подключении к MCP servers; но OpenAI прямо подчёркивает, что mTLS аутентифицирует ChatGPT как MCP client, а OAuth 2.1 всё равно нужен для аутентификации конечного пользователя.

Для Claude можно использовать allowlist egress-диапазонов Anthropic как дополнительный сетевой контроль, но не как замену OAuth.

## 8. Что настроить отдельно для ChatGPT и Claude

### ChatGPT

Поддержите OAuth 2.1 по MCP spec, preferably CIMD или DCR. ChatGPT ожидает protected resource metadata, OAuth/OIDC discovery, `resource` parameter, authorization-code + PKCE, а после linking будет отправлять bearer token на MCP-запросы.

Для redirect URI ChatGPT использует production redirect вида:

```text
https://chatgpt.com/connector/oauth/{callback_id}
```

Его надо добавить в allowlist вашего authorization server.

### Claude Desktop / Claude custom connector

Claude remote MCP поддерживает OAuth DCR, OAuth CIMD, Anthropic-held client credentials и no-auth; user-pasted bearer tokens и токены в URL query parameters не поддерживаются.

Для hosted Claude surfaces, включая Claude Desktop custom connectors, redirect URI:

```text
https://claude.ai/api/mcp/auth_callback
```

Для Claude Code — отдельный loopback redirect на localhost, если вы будете поддерживать ещё и Claude Code.

## 9. Минимальные правила безопасности для MCP tools

1. Не делайте tool вида “выполни произвольный запрос 1С/SQL”.
2. Разделяйте read tools и write/destructive tools.
3. Для destructive операций требуйте отдельный scope, например `mcp.1c.destructive`.
4. Логируйте всё: `external_sub`, `user_1c`, `client_id`, tool name, параметры, результат, request_id, IP/gateway, время.
5. Возвращайте модели только минимально нужные данные.
6. Не передавайте в модель токены, пароли, cookies, connection strings.
7. Для write tools делайте идемпотентность и подтверждения.
8. Для каждого tool указывайте MCP annotations вроде read-only/destructive hints; Claude прямо использует такие подсказки для понимания риска операций.
9. Учитывайте prompt injection: OpenAI отдельно предупреждает, что custom MCP может стать каналом чтения/эксфильтрации данных или нежелательных действий, если tool-ы слишком широкие или параметры не ограничены.

## 10. Итоговая рекомендация

Я бы делал так:

```text
1. Поставить/использовать корпоративный OAuth/OIDC IdP поверх LDAP/AD.
2. Опубликовать MCP только по HTTPS за WAF/API gateway.
3. Реализовать MCP OAuth metadata:
   - /.well-known/oauth-protected-resource
   - 401 WWW-Authenticate с resource_metadata
   - корректный resource/audience
4. Настроить ChatGPT и Claude как OAuth clients:
   - лучше CIMD/DCR, либо отдельные pre-registered clients
5. В access token включать стабильный subject пользователя.
6. В 1С вести явный mapping external subject -> пользователь 1С.
7. На каждый MCP-запрос:
   - проверить token
   - проверить scopes
   - найти пользователя 1С
   - проверить, что пользователь 1С активен
   - выполнить операцию с правами этого пользователя или через строгий policy layer
8. Не использовать общую полноправную учетку 1С как единственный механизм безопасности.
```

Самая правильная формулировка целевого состояния: **MCP OAuth отвечает на вопрос “кто пришёл и какие классы MCP-операций ему разрешены”, а 1С отвечает на вопрос “что конкретно этот пользователь 1С имеет право сделать в базе”**.
