// Unsigned Shortcut templates. `shortcuts sign` exists only on macOS, so the
// files in shortcuts/ are the plaintext plist from buildShortcut() and contain
// no device secret. The default template asks only for a push URL, then tells
// the phone apart when the body or sender is empty, or the push link answers
// 401, 429, another rejection, or no JSON. The code template keeps the older
// Bearer questions on action 1 (URL) and action 2 (token).

export const PLACEHOLDER_WEBHOOK = "https://example.workers.dev/api/v1/sms";

const URL_UUID = "11111111-1111-4111-8111-111111111111";
const TOKEN_UUID = "22222222-2222-4222-8222-222222222222";
const BEARER_UUID = "33333333-3333-4333-8333-333333333333";
const PLACEHOLDER_UUID = "55555555-5555-4555-8555-555555555555";
const RESPONSE_UUID = "66666666-6666-4666-8666-666666666666";
const CODE_GROUP = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
const WORD_GROUP = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB";
const GROUP_BODY = "CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC";
const GROUP_SENDER = "DDDDDDDD-DDDD-4DDD-8DDD-DDDDDDDDDDDD";
const GROUP_RATE = "EEEEEEEE-EEEE-4EEE-8EEE-EEEEEEEEEEEE";
const GROUP_DENIED = "FFFFFFFF-FFFF-4FFF-8FFF-FFFFFFFFFFFF";
const GROUP_REJECTED = "44444444-4444-4444-8444-444444444444";
const GROUP_NETWORK = "12121212-1212-4121-8121-121212121212";
const FROM_VARIABLE = "发件人";
const FROM_PLACEHOLDER = "（发件人为空）";
const OBJECT_REPLACEMENT = "\uFFFC";

export type ShortcutVariant = "all" | "code";

export function shortcutFilename(variant: ShortcutVariant): string {
  return variant === "code" ? "SMSinBox-iOS-code.shortcut" : "SMSinBox-iOS.shortcut";
}

export function normalizeWebhookUrl(value: string | undefined): string {
  if (!value?.trim()) return PLACEHOLDER_WEBHOOK;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return PLACEHOLDER_WEBHOOK;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return PLACEHOLDER_WEBHOOK;
  if (url.username || url.password) return PLACEHOLDER_WEBHOOK;
  return url.toString();
}

export function buildShortcut(variant: ShortcutVariant, webhookUrl?: string): string {
  if (variant === "all") return buildUnifiedShortcut();
  return buildLegacyShortcut(variant, webhookUrl);
}

function buildUnifiedShortcut(): string {
  const response = responseText();
  const actions = [
    commentAction(unifiedComment()),
    textAction(URL_UUID, "推送链接", str("")),
    ...guard(GROUP_BODY, undefined, extensionInput(), 101, "未发送：正文为空"),
    ...senderActions(),
    unifiedDownloadAction(),
    ...guard(GROUP_RATE, "请求过于频繁", response, 99, "未写入：请求过于频繁（429）。请稍后再试。"),
    ...guard(
      GROUP_DENIED,
      "推送链接",
      response,
      99,
      "未写入：推送链接无效或已撤销（401）。请在设备页轮换后重贴链接。",
    ),
    ...guard(GROUP_REJECTED, "false", response, 99, "未写入：服务器拒绝了这条短信。"),
    ...guard(
      GROUP_NETWORK,
      "ok",
      response,
      999,
      "未发送：网络失败，或返回的不是 JSON。请检查 iPhone 是否联网。若停在系统的「获取 URL 内容」报错、没有这条通知，同样是网络失败或推送链接为空。",
    ),
    notify("已转发"),
  ];
  const root = plistDict([
    ["WFWorkflowActions", plistArray(actions)],
    ["WFWorkflowClientVersion", str("4018.0.4")],
    ["WFWorkflowHasShortcutInputVariables", bool(true)],
    [
      "WFWorkflowIcon",
      plistDict([
        ["WFWorkflowIconGlyphNumber", int(61440)],
        ["WFWorkflowIconStartColor", int(431817727)],
      ]),
    ],
    ["WFWorkflowImportQuestions", plistArray([importQuestion(1, "推送链接", "")])],
    [
      "WFWorkflowInputContentItemClasses",
      plistArray([str("WFStringContentItem"), str("WFRichTextContentItem")]),
    ],
    ["WFWorkflowMinimumClientVersion", int(900)],
    ["WFWorkflowMinimumClientVersionString", str("900")],
    ["WFWorkflowName", str("SMSinBox")],
    ["WFWorkflowTypes", plistArray([])],
  ]);
  return plistDocument(root);
}

function unifiedComment(): string {
  return [
    "未签名模板。Linux 无法签名，因为 shortcuts sign 只能在 macOS 上运行。iOS 15 及更高版本经常拒绝导入未签名文件。请在你的 iPhone 上导入。iCloud 分享链接尚未发布。维护者还没有在 Mac 上真实分享之前，文档只会写「尚未发布」，这里也不会放链接。",
    "导入时只填写推送链接。这条链接是设备密钥，不要发到聊天或工单。本快捷指令用 POST 发送 JSON，标头只有 Content-Type: application/json，不要加 Authorization。content 是快捷指令输入。正文没有内容时会停住，不发送。from 优先用短信的 Sender；Sender 没有内容时改成「（发件人为空）」并仍然发送。要得到真实号码，把获取 URL 内容里的 from 改成这条自动化提供的「发件人」。timestamp 是当前日期，device 固定为 iOS。",
    "发送之后按服务器返回的文字区分结果：正文里的「请求过于频繁」表示 429；「推送链接无效」或「推送链接已撤销」表示 401；还有 false 表示服务器拒绝；没有 ok 表示网络失败、推送链接为空，或返回的不是 JSON。系统若直接停在获取 URL 内容的报错上，同样是网络失败或推送链接为空。",
    "只要验证码时不要另装一套主快捷指令。在「信息」自动化里把条件改成包含「验证码」，并再加一条包含 code。接近全部短信时用「信息包含一个空格」，这不是真正的全量，没有空格的短码匹配不到。共享来的自动化默认关闭，需要手动打开，选择立即运行，并关闭运行前询问。手机重启后要先解锁一次。这些步骤只能在你的 iPhone 上确认。",
  ].join("\n");
}

function senderActions(): string[] {
  return [
    conditional(0, GROUP_SENDER, undefined, extensionInput("Sender"), 101),
    textAction(PLACEHOLDER_UUID, "空发件人", str(FROM_PLACEHOLDER)),
    setVariable(FROM_VARIABLE, actionOutput("空发件人", PLACEHOLDER_UUID)),
    conditional(1, GROUP_SENDER),
    setVariable(FROM_VARIABLE, extensionInput("Sender")),
    conditional(2, GROUP_SENDER),
  ];
}

function guard(
  group: string,
  needle: string | undefined,
  input: string,
  condition: number,
  message: string,
): string[] {
  return [
    conditional(0, group, needle, input, condition),
    notify(message),
    action("is.workflow.actions.exit", plistDict([])),
    conditional(2, group),
  ];
}

function unifiedDownloadAction(): string {
  const headers = dictionaryValue([field("Content-Type", textToken("application/json"))]);
  const body = dictionaryValue([
    field("from", attachmentToken(namedVariable(FROM_VARIABLE))),
    field("content", attachmentToken(extensionInput())),
    field("timestamp", attachmentToken(plistDict([["Type", str("CurrentDate")]]))),
    field("device", textToken("iOS")),
  ]);
  const url = textToken(OBJECT_REPLACEMENT, [
    { range: "{0, 1}", body: actionOutput("推送链接", URL_UUID) },
  ]);
  return action(
    "is.workflow.actions.downloadurl",
    plistDict([
      ["CustomOutputName", str("响应")],
      ["UUID", str(RESPONSE_UUID)],
      ["Advanced", bool(true)],
      ["ShowHeaders", bool(true)],
      ["WFHTTPBodyType", str("JSON")],
      ["WFHTTPHeaders", headers],
      ["WFHTTPMethod", str("POST")],
      ["WFJSONValues", body],
      ["WFURL", url],
    ]),
  );
}

function buildLegacyShortcut(variant: ShortcutVariant, webhookUrl?: string): string {
  const webhook = normalizeWebhookUrl(webhookUrl);
  const actions = [
    commentAction(commentText(variant)),
    textAction(URL_UUID, "Webhook URL", str(webhook)),
    textAction(TOKEN_UUID, "设备 Token", str("")),
    textAction(
      BEARER_UUID,
      "Authorization",
      textToken(`Bearer ${OBJECT_REPLACEMENT}`, [
        { range: "{7, 1}", body: actionOutput("设备 Token", TOKEN_UUID) },
      ]),
    ),
    ...filterActions(variant),
    downloadAction(),
    action(
      "is.workflow.actions.notification",
      plistDict([
        ["WFNotificationActionBody", str("已转发")],
        ["WFNotificationActionTitle", str("SMSinBox")],
      ]),
    ),
  ];
  const root = plistDict([
    ["WFWorkflowActions", plistArray(actions)],
    ["WFWorkflowClientVersion", str("4018.0.4")],
    ["WFWorkflowHasShortcutInputVariables", bool(true)],
    [
      "WFWorkflowIcon",
      plistDict([
        ["WFWorkflowIconGlyphNumber", int(61440)],
        ["WFWorkflowIconStartColor", int(431817727)],
      ]),
    ],
    [
      "WFWorkflowImportQuestions",
      plistArray([
        importQuestion(1, "Webhook URL", webhook),
        importQuestion(2, "设备 token", ""),
      ]),
    ],
    [
      "WFWorkflowInputContentItemClasses",
      plistArray([str("WFStringContentItem"), str("WFRichTextContentItem")]),
    ],
    ["WFWorkflowMinimumClientVersion", int(900)],
    ["WFWorkflowMinimumClientVersionString", str("900")],
    ["WFWorkflowName", str(variant === "code" ? "SMSinBox 验证码" : "SMSinBox")],
    ["WFWorkflowTypes", plistArray([])],
  ]);
  return plistDocument(root);
}

function plistDocument(root: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${indent(root)}
</plist>
`;
}

function commentText(variant: ShortcutVariant): string {
  const filter =
    variant === "code"
      ? "正文不包含「验证码」或 code 时，快捷指令会停止，不会发送请求。短码短信如果没有空格，用这一版，或在自动化里另加「验证码」和 code。"
      : "把本快捷指令放进「信息」自动化，触发条件选「信息包含一个空格」。这是最接近全部短信的规则。";
  return [
    "未签名模板。Linux 无法签名，因为 shortcuts sign 只能在 macOS 上运行。iOS 15 及更高版本经常拒绝导入未签名文件。请在 iPhone 上导入，或使用 iCloud 分享链接。维护者还没有发布链接时，文档会写「尚未发布」。",
    "导入时填写 Webhook URL 和设备 token。本快捷指令用 POST 发送 JSON，Authorization 头为 Bearer 加上设备 token。from 会尝试读取短信的 Sender；如果结果是空的，请把 from 改成自动化提供的「发件人」变量。content 是快捷指令输入，timestamp 是当前日期，device 固定为 iOS。",
    `${filter}共享来的自动化默认关闭，需要手动打开，并关闭运行前询问。`,
  ].join("\n");
}

function filterActions(variant: ShortcutVariant): string[] {
  if (variant !== "code") return [];
  return [
    conditional(0, CODE_GROUP, "验证码"),
    conditional(1, CODE_GROUP),
    conditional(0, WORD_GROUP, "code"),
    conditional(1, WORD_GROUP),
    action("is.workflow.actions.exit", plistDict([])),
    conditional(2, WORD_GROUP),
    conditional(2, CODE_GROUP),
  ];
}

function downloadAction(): string {
  const headers = dictionaryValue([
    field(
      "Authorization",
      textToken(OBJECT_REPLACEMENT, [{ range: "{0, 1}", body: actionOutput("Authorization", BEARER_UUID) }]),
    ),
    field("Content-Type", textToken("application/json")),
  ]);
  const body = dictionaryValue([
    field("from", attachmentToken(extensionInput("Sender"))),
    field("content", attachmentToken(extensionInput())),
    field("timestamp", attachmentToken(plistDict([["Type", str("CurrentDate")]]))),
    field("device", textToken("iOS")),
  ]);
  const url = textToken(OBJECT_REPLACEMENT, [
    { range: "{0, 1}", body: actionOutput("Webhook URL", URL_UUID) },
  ]);
  return action(
    "is.workflow.actions.downloadurl",
    plistDict([
      ["Advanced", bool(true)],
      ["ShowHeaders", bool(true)],
      ["WFHTTPBodyType", str("JSON")],
      ["WFHTTPHeaders", headers],
      ["WFHTTPMethod", str("POST")],
      ["WFJSONValues", body],
      ["WFURL", url],
    ]),
  );
}

function conditional(
  mode: 0 | 1 | 2,
  group: string,
  needle?: string,
  input?: string,
  condition = 99,
): string {
  const entries: Array<[string, string]> = [
    ["GroupingIdentifier", str(group)],
    ["WFControlFlowMode", int(mode)],
  ];
  const subject = input ?? (needle !== undefined ? extensionInput() : undefined);
  if (mode === 0 && subject) {
    entries.push(["WFCondition", int(condition)]);
    if (needle !== undefined) entries.push(["WFConditionalActionString", str(needle)]);
    entries.push([
      "WFInput",
      plistDict([["Type", str("Variable")], ["Variable", attachmentToken(subject)]]),
    ]);
  }
  return action("is.workflow.actions.conditional", plistDict(entries));
}

function notify(body: string): string {
  return action(
    "is.workflow.actions.notification",
    plistDict([
      ["WFNotificationActionBody", str(body)],
      ["WFNotificationActionTitle", str("SMSinBox")],
    ]),
  );
}

function setVariable(name: string, input: string): string {
  return action(
    "is.workflow.actions.setvariable",
    plistDict([
      ["WFInput", attachmentToken(input)],
      ["WFVariableName", str(name)],
    ]),
  );
}

function namedVariable(name: string): string {
  return plistDict([
    ["Type", str("Variable")],
    ["VariableName", str(name)],
  ]);
}

function responseText(): string {
  return plistDict([
    [
      "Aggrandizements",
      plistArray([
        plistDict([
          ["CoercionItemClass", str("WFStringContentItem")],
          ["Type", str("WFCoercionVariableAggrandizement")],
        ]),
      ]),
    ],
    ["OutputName", str("响应")],
    ["OutputUUID", str(RESPONSE_UUID)],
    ["Type", str("ActionOutput")],
  ]);
}

function commentAction(text: string): string {
  return action("is.workflow.actions.comment", plistDict([["WFCommentActionText", str(text)]]));
}

function textAction(uuid: string, outputName: string, textXml: string): string {
  return action(
    "is.workflow.actions.gettext",
    plistDict([
      ["CustomOutputName", str(outputName)],
      ["UUID", str(uuid)],
      ["WFTextActionText", textXml],
    ]),
  );
}

function importQuestion(index: number, prompt: string, defaultValue: string): string {
  return plistDict([
    ["ActionIndex", int(index)],
    ["Category", str("Parameter")],
    ["DefaultValue", str(defaultValue)],
    ["ParameterKey", str("WFTextActionText")],
    ["Text", str(prompt)],
  ]);
}

function action(identifier: string, parameters: string): string {
  return plistDict([
    ["WFWorkflowActionIdentifier", str(identifier)],
    ["WFWorkflowActionParameters", parameters],
  ]);
}

function actionOutput(name: string, uuid: string): string {
  return plistDict([
    ["OutputName", str(name)],
    ["OutputUUID", str(uuid)],
    ["Type", str("ActionOutput")],
  ]);
}

function extensionInput(property?: string): string {
  const entries: Array<[string, string]> = [];
  if (property) {
    entries.push([
      "Aggrandizements",
      plistArray([
        plistDict([
          ["PropertyName", str(property)],
          ["Type", str("WFPropertyVariableAggrandizement")],
        ]),
      ]),
    ]);
  }
  entries.push(["Type", str("ExtensionInput")]);
  return plistDict(entries);
}

function attachmentToken(value: string): string {
  return plistDict([
    ["Value", value],
    ["WFSerializationType", str("WFTextTokenAttachment")],
  ]);
}

function textToken(text: string, attachments: Array<{ range: string; body: string }> = []): string {
  const value: Array<[string, string]> = [["string", str(text)]];
  if (attachments.length > 0) {
    value.push(["attachmentsByRange", plistDict(attachments.map((item) => [item.range, item.body]))]);
  }
  return plistDict([
    ["Value", plistDict(value)],
    ["WFSerializationType", str("WFTextTokenString")],
  ]);
}

function dictionaryValue(items: string[]): string {
  return plistDict([
    ["Value", plistDict([["WFDictionaryFieldValueItems", plistArray(items)]])],
    ["WFSerializationType", str("WFDictionaryFieldValue")],
  ]);
}

function field(name: string, value: string): string {
  return plistDict([
    ["WFItemType", int(0)],
    ["WFKey", textToken(name)],
    ["WFValue", value],
  ]);
}

function plistDict(entries: Array<[string, string]>): string {
  if (entries.length === 0) return "<dict/>";
  const lines: string[] = [];
  for (const [name, value] of entries) {
    lines.push(`<key>${xmlEscape(name)}</key>`, value);
  }
  return `<dict>\n${indent(lines.join("\n"))}\n</dict>`;
}

function plistArray(items: string[]): string {
  if (items.length === 0) return "<array/>";
  return `<array>\n${indent(items.join("\n"))}\n</array>`;
}

function str(value: string): string {
  return `<string>${xmlEscape(value)}</string>`;
}

function int(value: number): string {
  return `<integer>${value}</integer>`;
}

function bool(value: boolean): string {
  return value ? "<true/>" : "<false/>";
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function indent(xml: string): string {
  return xml
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
