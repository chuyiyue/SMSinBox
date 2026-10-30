declare module "cloudflare:sockets" {
  function connect(
    address: { hostname: string; port: number } | string,
    options?: { secureTransport?: "on" | "off" | "starttls"; allowHalfOpen?: boolean },
  ): Socket;
}
