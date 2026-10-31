// Unsigned Shortcut templates. `shortcuts sign` exists only on macOS, so the
// files in shortcuts/ are the plaintext plist from buildShortcut() with no
// webhook argument. Regenerate those files when this generator changes.
// Import questions stay on action 1 (URL) and action 2 (token) for both variants.

export const PLACEHOLDER_WEBHOOK = "https://example.workers.dev/api/v1/sms";

const URL_UUID = "11111111-1111-4111-8111-111111111111";
const TOKEN_UUID = "22222222-2222-4222-8222-222222222222";
const BEARER_UUID = "33333333-3333-4333-8333-333333333333";
const CODE_GROUP = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
const WORD_GROUP = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB";
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

function conditional(mode: 0 | 1 | 2, group: string, needle?: string): string {
  const entries: Array<[string, string]> = [
    ["GroupingIdentifier", str(group)],
    ["WFControlFlowMode", int(mode)],
  ];
  if (mode === 0 && needle !== undefined) {
    entries.push(
      ["WFCondition", int(99)],
      ["WFConditionalActionString", str(needle)],
      ["WFInput", plistDict([["Type", str("Variable")], ["Variable", attachmentToken(extensionInput())]])],
    );
  }
  return action("is.workflow.actions.conditional", plistDict(entries));
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
