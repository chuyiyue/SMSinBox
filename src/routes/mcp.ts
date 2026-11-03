// MCP (Model Context Protocol) Server endpoint at /mcp
// Implements Streamable HTTP JSON-RPC 2.0 for read-only tools.
// Authenticated with Bearer token, shared with REST external API.

import { resolveContentKey } from "../crypto";
import {
  getExtDevice,
  getExtMessage,
  getLastMessageTimeForDevice,
  getLatestExtOtp,
  listExtDevices,
  listExtMessages,
  listExtOtp,
} from "../db";
import { json } from "../http";
import { compileLikeQuery } from "../search";
import { APP_VERSION } from "../version";
import {
  deriveDeviceStatus,
  deviceInScope,
  hasPermission,
  requireExtToken,
  type AuthedToken,
  type ExtPermission,
} from "./ext-auth";
import { formatExtMessage } from "./ext-api";

type WaitCtx = { waitUntil(promise: Promise<unknown>): void };

const MCP_TOOLS = [
  {
    name: "list_messages",
    description: "List recent SMS messages within the authorized device scope (paginated).",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20, description: "Max messages to return" },
        offset: { type: "integer", minimum: 0, default: 0, description: "Offset for pagination" },
        device_id: { type: "string", description: "Filter by specific device ID" },
        since: { type: "integer", description: "Filter messages received at or after this timestamp (ms)" },
        until: { type: "integer", description: "Filter messages received at or before this timestamp (ms)" },
      },
    },
  },
  {
    name: "search_messages",
    description: "Search SMS messages by keyword query, sender, and/or device.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Search keyword matching content, from, or code" },
        from: { type: "string", description: "Filter by sender phone number or name" },
        device_id: { type: "string", description: "Filter by specific device ID" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20, description: "Max messages to return" },
        offset: { type: "integer", minimum: 0, default: 0, description: "Offset for pagination" },
      },
    },
  },
  {
    name: "get_message",
    description: "Get full details of a single SMS message by its ID.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "The UUID of the SMS message" },
      },
    },
  },
  {
    name: "get_latest_otp",
    description: "Get the most recent SMS verification code (OTP). Returns not found if none exists.",
    inputSchema: {
      type: "object",
      properties: {
        device_id: { type: "string", description: "Filter by specific device ID" },
        from: { type: "string", description: "Filter by sender phone number" },
        since: { type: "integer", description: "Only return OTP received at or after this timestamp (ms)" },
      },
    },
  },
  {
    name: "search_otp",
    description: "Search SMS verification codes with pagination, time range, and sender/device filters.",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "integer", description: "Filter OTPs received at or after this timestamp (ms)" },
        until: { type: "integer", description: "Filter OTPs received at or before this timestamp (ms)" },
        device_id: { type: "string", description: "Filter by specific device ID" },
        from: { type: "string", description: "Filter by sender phone number" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20, description: "Max items to return" },
        offset: { type: "integer", minimum: 0, default: 0, description: "Offset for pagination" },
      },
    },
  },
  {
    name: "list_devices",
    description: "List all devices within the authorized scope, including their online status and platform.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_device_status",
    description: "Get current status, last seen time, and latest message time of a specific device.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "The UUID of the device" },
      },
    },
  },
];

export async function handleMcp(request: Request, env: Env, _ctx: WaitCtx = { waitUntil() {} }): Promise<Response> {
  const method = request.method.toUpperCase();

  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        allow: "POST, OPTIONS",
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "Authorization, Content-Type",
      },
    });
  }

  if (method !== "POST") {
    return json({ ok: false, error: "POST required for MCP JSON-RPC" }, 405, { allow: "POST" });
  }

  // MCP Bearer authentication
  const auth = await requireExtToken(request, env);
  if (auth instanceof Response) return auth;
  const token = auth;

  let body: Record<string, unknown> | null = null;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }

  if (!body || typeof body !== "object") {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }, 400);
  }

  const id = (body.id as string | number | null) ?? null;
  const rpcMethod = body.method;

  if (typeof rpcMethod !== "string") {
    return json({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request: missing method" } }, 400);
  }

  // MCP protocol notifications
  if (rpcMethod === "notifications/initialized") {
    return new Response(null, { status: 202 });
  }

  // MCP ping
  if (rpcMethod === "ping") {
    return json({ jsonrpc: "2.0", id, result: {} });
  }

  // MCP initialize
  if (rpcMethod === "initialize") {
    return json({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "smsinbox-mcp",
          version: APP_VERSION,
        },
      },
    });
  }

  // MCP tools/list
  if (rpcMethod === "tools/list") {
    return json({
      jsonrpc: "2.0",
      id,
      result: {
        tools: MCP_TOOLS,
      },
    });
  }

  // MCP tools/call
  if (rpcMethod === "tools/call") {
    const params = body.params as Record<string, unknown> | undefined;
    const toolName = typeof params?.name === "string" ? params.name : "";
    const args = (params?.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>;

    const callResult = await executeMcpTool(toolName, args, env, token);
    return json({
      jsonrpc: "2.0",
      id,
      result: callResult,
    });
  }

  return json(
    {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: `Method not found: ${rpcMethod}`,
      },
    },
    404,
  );
}

interface ToolCallResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

async function executeMcpTool(
  toolName: string,
  args: Record<string, unknown>,
  env: Env,
  token: AuthedToken,
): Promise<ToolCallResult> {
  switch (toolName) {
    case "list_messages":
      return toolListMessages(args, env, token);
    case "search_messages":
      return toolSearchMessages(args, env, token);
    case "get_message":
      return toolGetMessage(args, env, token);
    case "get_latest_otp":
      return toolGetLatestOtp(args, env, token);
    case "search_otp":
      return toolSearchOtp(args, env, token);
    case "list_devices":
      return toolListDevices(env, token);
    case "get_device_status":
      return toolGetDeviceStatus(args, env, token);
    default:
      return {
        content: [{ type: "text", text: `Error: Unknown tool "${toolName}"` }],
        isError: true,
      };
  }
}

async function toolListMessages(
  args: Record<string, unknown>,
  env: Env,
  token: AuthedToken,
): Promise<ToolCallResult> {
  if (!hasPermission(token, "messages:read")) {
    return permDenied("messages:read");
  }

  const limit = parseBoundedNumber(args.limit, 20, 1, 100);
  const offset = parseBoundedNumber(args.offset, 0, 0, 1_000_000);
  const deviceId = typeof args.device_id === "string" ? args.device_id.trim() : null;
  const since = typeof args.since === "number" ? args.since : null;
  const until = typeof args.until === "number" ? args.until : null;

  if (deviceId && !deviceInScope(token, deviceId)) {
    return {
      content: [{ type: "text", text: "共 0 条短信（指定设备不在授权范围内）" }],
      structuredContent: { total: 0, messages: [] },
    };
  }

  const contentKey = resolveContentKey(env.CONTENT_KEY);
  const result = await listExtMessages(env.DB, {
    userId: token.user_id,
    scopeDeviceIds: token.device_scope,
    deviceId,
    from: null,
    since,
    until,
    like: null,
    limit,
    offset,
    contentKey,
  });

  const formattedMessages = result.messages.map(formatExtMessage);
  const lines = [
    `共 ${result.total} 条短信 (显示第 ${offset + 1} - ${offset + formattedMessages.length} 条):`,
    ...formattedMessages.map(
      (m) =>
        `- [${m.id}] 来自 ${m.from} (${new Date(m.received_at).toLocaleString("zh-CN")}): ${m.content.slice(0, 80)}${m.content.length > 80 ? "…" : ""}${m.code ? ` [验证码: ${m.code}]` : ""}`,
    ),
  ];

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      total: result.total,
      limit,
      offset,
      messages: formattedMessages,
    },
  };
}

async function toolSearchMessages(
  args: Record<string, unknown>,
  env: Env,
  token: AuthedToken,
): Promise<ToolCallResult> {
  if (!hasPermission(token, "messages:read")) {
    return permDenied("messages:read");
  }

  const q = typeof args.q === "string" ? args.q.trim() : null;
  const from = typeof args.from === "string" ? args.from.trim() : null;
  const deviceId = typeof args.device_id === "string" ? args.device_id.trim() : null;
  const limit = parseBoundedNumber(args.limit, 20, 1, 100);
  const offset = parseBoundedNumber(args.offset, 0, 0, 1_000_000);

  if (deviceId && !deviceInScope(token, deviceId)) {
    return {
      content: [{ type: "text", text: "共 0 条匹配短信（指定设备不在授权范围内）" }],
      structuredContent: { total: 0, messages: [] },
    };
  }

  const like = compileLikeQuery(q);
  if (!like.ok) {
    return {
      content: [{ type: "text", text: `搜索词错误: ${like.error}` }],
      isError: true,
    };
  }

  const contentKey = resolveContentKey(env.CONTENT_KEY);
  const result = await listExtMessages(env.DB, {
    userId: token.user_id,
    scopeDeviceIds: token.device_scope,
    deviceId,
    from,
    since: null,
    until: null,
    like: like.pattern,
    text: q,
    limit,
    offset,
    contentKey,
  });

  const formattedMessages = result.messages.map(formatExtMessage);
  const lines = [
    `搜索结果: 共 ${result.total} 条匹配短信 (显示第 ${offset + 1} - ${offset + formattedMessages.length} 条):`,
    ...formattedMessages.map(
      (m) =>
        `- [${m.id}] 来自 ${m.from} (${new Date(m.received_at).toLocaleString("zh-CN")}): ${m.content.slice(0, 80)}${m.content.length > 80 ? "…" : ""}${m.code ? ` [验证码: ${m.code}]` : ""}`,
    ),
  ];

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      total: result.total,
      limit,
      offset,
      messages: formattedMessages,
    },
  };
}

async function toolGetMessage(
  args: Record<string, unknown>,
  env: Env,
  token: AuthedToken,
): Promise<ToolCallResult> {
  if (!hasPermission(token, "messages:read")) {
    return permDenied("messages:read");
  }

  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) {
    return {
      content: [{ type: "text", text: "参数错误: 缺少 id" }],
      isError: true,
    };
  }

  const contentKey = resolveContentKey(env.CONTENT_KEY);
  const message = await getExtMessage(env.DB, token.user_id, id, token.device_scope, contentKey);
  if (!message) {
    return {
      content: [{ type: "text", text: "未找到短信，或该短信所在设备不在授权范围内" }],
      isError: true,
    };
  }

  const formatted = formatExtMessage(message);
  const text = [
    `短信 ID: ${formatted.id}`,
    `发件号码: ${formatted.from}`,
    `收件号码: ${formatted.to ?? "无"}`,
    `设备: ${formatted.device_name} (${formatted.device_id})`,
    `接收时间: ${new Date(formatted.received_at).toLocaleString("zh-CN")}`,
    formatted.code ? `提取验证码: ${formatted.code}` : "未识别到验证码",
    `短信正文:\n${formatted.content}`,
  ].join("\n");

  return {
    content: [{ type: "text", text }],
    structuredContent: formatted,
  };
}

async function toolGetLatestOtp(
  args: Record<string, unknown>,
  env: Env,
  token: AuthedToken,
): Promise<ToolCallResult> {
  if (!hasPermission(token, "otp:read")) {
    return permDenied("otp:read");
  }

  const deviceId = typeof args.device_id === "string" ? args.device_id.trim() : null;
  const from = typeof args.from === "string" ? args.from.trim() : null;
  const since = typeof args.since === "number" ? args.since : null;

  if (deviceId && !deviceInScope(token, deviceId)) {
    return {
      content: [{ type: "text", text: "未找到符合条件的验证码" }],
      structuredContent: null,
    };
  }

  const contentKey = resolveContentKey(env.CONTENT_KEY);
  const message = await getLatestExtOtp(env.DB, {
    userId: token.user_id,
    scopeDeviceIds: token.device_scope,
    deviceId,
    from,
    since,
    contentKey,
  });

  if (!message || !message.code) {
    return {
      content: [{ type: "text", text: "未找到符合条件的验证码" }],
      structuredContent: null,
    };
  }

  const text = [
    `最新验证码: ${message.code}`,
    `发件号码: ${message.from_number}`,
    `设备: ${message.device_name}`,
    `接收时间: ${new Date(message.received_at).toLocaleString("zh-CN")}`,
    `短信内容: ${message.content}`,
  ].join("\n");

  return {
    content: [{ type: "text", text }],
    structuredContent: {
      code: message.code,
      from: message.from_number,
      content: message.content,
      device_id: message.device_id,
      device_name: message.device_name,
      received_at: message.received_at,
      code_source: message.code_source,
      code_status: "recognized",
    },
  };
}

async function toolSearchOtp(
  args: Record<string, unknown>,
  env: Env,
  token: AuthedToken,
): Promise<ToolCallResult> {
  if (!hasPermission(token, "otp:read")) {
    return permDenied("otp:read");
  }

  const since = typeof args.since === "number" ? args.since : null;
  const until = typeof args.until === "number" ? args.until : null;
  const deviceId = typeof args.device_id === "string" ? args.device_id.trim() : null;
  const from = typeof args.from === "string" ? args.from.trim() : null;
  const limit = parseBoundedNumber(args.limit, 20, 1, 100);
  const offset = parseBoundedNumber(args.offset, 0, 0, 1_000_000);

  if (deviceId && !deviceInScope(token, deviceId)) {
    return {
      content: [{ type: "text", text: "共 0 条验证码（指定设备不在授权范围内）" }],
      structuredContent: { total: 0, otps: [] },
    };
  }

  const contentKey = resolveContentKey(env.CONTENT_KEY);
  const result = await listExtOtp(env.DB, {
    userId: token.user_id,
    scopeDeviceIds: token.device_scope,
    deviceId,
    from,
    since,
    until,
    limit,
    offset,
    contentKey,
  });

  const otps = result.messages.map((m) => ({
    id: m.id,
    code: m.code,
    from: m.from_number,
    content: m.content,
    device_id: m.device_id,
    device_name: m.device_name,
    received_at: m.received_at,
    code_source: m.code_source,
    code_status: m.code ? "recognized" : "none",
  }));

  const lines = [
    `共 ${result.total} 条验证码 (显示第 ${offset + 1} - ${offset + otps.length} 条):`,
    ...otps.map(
      (o) =>
        `- 验证码 [${o.code}] 来自 ${o.from} (${new Date(o.received_at).toLocaleString("zh-CN")}, 设备: ${o.device_name}): ${o.content.slice(0, 60)}`,
    ),
  ];

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      total: result.total,
      limit,
      offset,
      otps,
    },
  };
}

async function toolListDevices(
  env: Env,
  token: AuthedToken,
): Promise<ToolCallResult> {
  if (!hasPermission(token, "devices:read")) {
    return permDenied("devices:read");
  }

  const rows = await listExtDevices(env.DB, token.user_id, token.device_scope);
  const now = Date.now();
  const devices = rows.map((d) => ({
    id: d.id,
    name: d.name,
    platform: d.platform,
    created_at: d.created_at,
    last_seen_at: d.last_seen_at,
    status: deriveDeviceStatus(d.last_seen_at, now),
  }));

  const lines = [
    `授权范围内共有 ${devices.length} 台设备:`,
    ...devices.map(
      (d) =>
        `- ${d.name} (ID: ${d.id}, 平台: ${d.platform}, 状态: ${d.status}, 最后在线: ${d.last_seen_at ? new Date(d.last_seen_at).toLocaleString("zh-CN") : "从未上报"})`,
    ),
  ];

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: devices,
  };
}

async function toolGetDeviceStatus(
  args: Record<string, unknown>,
  env: Env,
  token: AuthedToken,
): Promise<ToolCallResult> {
  if (!hasPermission(token, "devices:status")) {
    return permDenied("devices:status");
  }

  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) {
    return {
      content: [{ type: "text", text: "参数错误: 缺少 id" }],
      isError: true,
    };
  }

  const device = await getExtDevice(env.DB, token.user_id, id, token.device_scope);
  if (!device) {
    return {
      content: [{ type: "text", text: "未找到设备，或该设备不在授权范围内" }],
      isError: true,
    };
  }

  const lastMessageAt = await getLastMessageTimeForDevice(env.DB, id);
  const now = Date.now();
  const status = deriveDeviceStatus(device.last_seen_at, now);

  const text = [
    `设备名称: ${device.name}`,
    `设备 ID: ${device.id}`,
    `平台: ${device.platform}`,
    `在线状态: ${status}`,
    `最后上报时间: ${device.last_seen_at ? new Date(device.last_seen_at).toLocaleString("zh-CN") : "从未上报"}`,
    `最新短信时间: ${lastMessageAt ? new Date(lastMessageAt).toLocaleString("zh-CN") : "无短信记录"}`,
  ].join("\n");

  return {
    content: [{ type: "text", text }],
    structuredContent: {
      id: device.id,
      name: device.name,
      platform: device.platform,
      last_seen_at: device.last_seen_at,
      status,
      last_message_at: lastMessageAt,
    },
  };
}

function permDenied(perm: ExtPermission): ToolCallResult {
  return {
    content: [{ type: "text", text: `权限不足: 该工具需要 ${perm} 权限` }],
    isError: true,
  };
}

function parseBoundedNumber(val: unknown, fallback: number, min: number, max: number): number {
  if (typeof val !== "number" || !Number.isFinite(val)) return fallback;
  return Math.min(Math.max(Math.floor(val), min), max);
}
