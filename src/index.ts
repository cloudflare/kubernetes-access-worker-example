import { jwtVerify, createRemoteJWKSet } from "jose";
import { contextStorage, getContext, WorkerContext } from "./context";
import { logK8sWebSocket, logK8sHttp, logSystem, logSystemError } from "./log";

/**
 * Defines the Kubernetes identity attributes used for API server impersonation.
 * These fields directly correspond to the standard Kubernetes Impersonation
 * headers:
 * - `user` maps to `Impersonate-User`
 * - `groups` maps to `Impersonate-Group`
 * @see
 * {@link https://kubernetes.io/docs/reference/access-authn-authz/authentication/#user-impersonation | Kubernetes User Impersonation Docs}
 */
export type K8sIdentity = {
  /** The validated Access JWT identity mapped to this K8s identity. */
  accessJwtIdentity: string;

  /**
   * The username to impersonate inside the cluster.
   */
  user: string;

  /**
   * A list of groups to impersonate inside the cluster (e.g., `system:masters`,
   * `system:authenticated`). These are passed via multiple `Impersonate-Group`
   * headers.
   */
  groups: string[];
};

/**
 * This lookup table is used to translate the validated `email` claim from the
 * Access JWT into the concrete `user` and `groups` needed for K8s impersonation
 * headers.
 */
const IDENTITY_MAP: Record<string, K8sIdentity> = {
  "alice@mydomain.com": {
    accessJwtIdentity: "alice@mydomain.com",
    // Does not matter since group is superuser, but still required for
    // impersonation to specify username
    user: "foobar",
    groups: ["system:masters"],
  },
};

/**
 * Represents the decoded payload of a Cloudflare Access Application JSON Web
 * Token (JWT). This token is passed to the origin application via the
 * `Cf-Access-Jwt-Assertion` header when a request is authorized by Cloudflare
 * Zero Trust.
 * @remarks
 * **Security Warning:** Do not trust these claims without first validating the
 * JWT signature using the public keys from your Cloudflare Access team domain
 * and verifying that the `aud` claim matches your specific application's
 * Audience Tag.
 * @see
 * {@link https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/ | Cloudflare Access Docs: Validating JWTs}
 */
interface AccessJwtClaims {
  /** The issuance timestamp of the JWT (Unix time).*/
  iat: number;
  /** The expiration timestamp of the JWT (Unix time).*/
  exp: number;
  /** The Cloudflare Access domain URL for the application.*/
  iss: string;
  /** Contains an empty string when authentication was through a service token.*/
  sub: string;
  /** The application audience (AUD) tag of the Access application.*/
  aud: string;
  /** The ID of the device used for authentication. (WARP session auth)*/
  device_id?: string;
  /** The email address of the user.*/
  email: string;
  /** Whether warp session was used as auth.*/
  warp_as_auth: boolean;
  /** The Client ID of the service token (CF-Access-Client-Id).*/
  common_name?: string;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const context: WorkerContext = {
      ...env,
    };

    return contextStorage.run(context, async () => {
      return await handleRequest(request);
    });
  },
};

async function handleRequest(request: Request) {
  // Get the JWT from the request headers
  const jwt = request.headers.get("cf-access-jwt-assertion");
  // Check if token exists
  if (!jwt) {
    return new Response("Missing required CF Access JWT", {
      status: 403,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Validate Access JWT
  let claims: AccessJwtClaims;
  try {
    claims = await validateAccessJwt(jwt);
    logSystem("debug", "Got valid Access JWT", { claims: claims });
  } catch (error) {
    // JWT verification failed
    logSystemError("JWT verification failed", error);
    return new Response(`Invalid JWT`, {
      status: 403,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Lookup K8s identity
  const k8sIdentity = mapAccessIdentityToK8s(claims);
  if (!k8sIdentity) {
    return new Response(
      `Forbidden: No Kubernetes mapping for user ${claims.email}`,
      {
        status: 403,
        headers: { "Content-Type": "text/plain" },
      },
    );
  }

  logSystem(
    "debug",
    `Proxying request for ${claims.email} as K8s user: ${k8sIdentity.user}, groups: ${k8sIdentity.groups.join(",")}`,
  );

  // Proxy the request
  try {
    const response = await proxyToKubernetes(request, k8sIdentity);
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    logSystemError("Error in proxy", error);
    return new Response(`Internal Server Error: ${message}`, {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
  }
}

/**
 * Validates a Cloudflare Access JWT by querying the team domain's JWKS
 * endpoint.
 *
 * This function verifies that the token is cryptographically signed by
 * Cloudflare and confirms that the `aud` (Audience) claim matches this specific
 * application.
 *
 * @param jwt - The raw JWT string extracted from the `Cf-Access-Jwt-Assertion`
 * header.
 * @returns The decoded and verified {@link AccessJwtClaims}.
 * @throws {Error} If the signature is invalid, the token has expired, or the
 * `aud` claim does not match.
 */
async function validateAccessJwt(jwt: string): Promise<AccessJwtClaims> {
  // Source: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/#cloudflare-workers-example

  const { ACCESS_TEAM_DOMAIN, ACCESS_AUD } = getContext();

  // Create JWKS from your team domain
  const JWKS = createRemoteJWKSet(
    new URL(`${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`),
  );

  // Verify the JWT
  const { payload } = await jwtVerify<AccessJwtClaims>(jwt, JWKS, {
    issuer: ACCESS_TEAM_DOMAIN,
    audience: ACCESS_AUD,
  });

  // Token is valid, proceed with application logic
  return payload;
}

/**
 * Proxies an incoming request to the Kubernetes API server, routing traffic
 * based on connection type (Standard HTTP vs. WebSocket).
 *
 * This function inspects the `Upgrade` header to determine if the request
 * requires a persistent streaming connection (used by `kubectl exec`, `attach`,
 * and `port-forward`) or a standard HTTP request/response cycle for Kubernetes
 * REST API.
 *
 * @param request - The original incoming HTTP request.
 * @param k8sIdentity - The resolved Kubernetes identity to be used for
 * `Impersonate-*` headers.
 * @returns The response from the Kubernetes API server.
 */
async function proxyToKubernetes(
  request: Request,
  k8sIdentity: K8sIdentity,
): Promise<Response> {
  const upgradeHeader = request.headers.get("Upgrade");
  const isWebSocketUpgrade =
    upgradeHeader && upgradeHeader.toLowerCase() === "websocket";
  // WebSocket streaming (kube exec, port forwarding, etc.)
  if (isWebSocketUpgrade) {
    logSystem("debug", "Got WebSocket upgrade request");
    return handleStreamingUpgrade(request, k8sIdentity);
  }

  // Regular HTTP proxying
  return handleHTTPRequest(request, k8sIdentity);
}

/**
 * Proxies standard HTTP requests to the Kubernetes API server.
 *
 * This function reconstructs the incoming request by:
 * 1. Rewriting the URL to target the configured `KUBE_API_SERVER`.
 * 2. Injecting Kubernetes impersonation headers via `buildKubeHeaders`.
 * 3. Preserving the original HTTP method and request body.
 *
 * It uses the `KUBE_API` WVPC binding to securely fetch the upstream response
 * from your Cloudflare Tunnel running in your cluster.
 *
 * @param request - The original incoming HTTP request.
 * @param k8sIdentity - The identity attributes used to generate
 * `Impersonate-User` and `Impersonate-Group` headers.
 * @returns The raw response from the Kubernetes API server.
 */
async function handleHTTPRequest(
  request: Request,
  k8sIdentity: K8sIdentity,
): Promise<Response> {
  const { KUBE_API_SERVER, KUBE_API } = getContext();
  const url = new URL(request.url);
  logSystem(
    "debug",
    `Proxying HTTP ${JSON.stringify(request.method)} ${JSON.stringify(url.pathname)}`,
  );

  // Build proxy request
  const headers = buildKubeHeaders(request, k8sIdentity);
  const targetUrl = new URL(`${KUBE_API_SERVER}${url.pathname}${url.search}`);
  // Create new request with the target URL but preserve all other properties
  const proxyRequest = new Request(targetUrl, {
    method: request.method,
    headers: headers,
    body: request.body,
  });

  // Measure upstream latency
  const start = performance.now();

  // Call Kube API
  const response = await KUBE_API.fetch(proxyRequest);

  const end = performance.now();
  const durationMs = end - start;

  // Log k8s log
  const context = getContext();
  await logK8sHttp(
    request,
    response.status,
    k8sIdentity,
    {
      upstreamLatencyMs: durationMs,
      response,
    },
    context,
  );

  return response;
}

/**
 * Establishes a bidirectional WebSocket tunnel between the client and the
 * Kubernetes API.
 *
 * This function handles the WebSocket upgrade handshake used by interactive
 * `kubectl` commands (like `exec`, `attach`, `logs -f`, and `port-forward`). It
 * performs the following steps:
 * 1. Initiates a WebSocket connection to the upstream Kubernetes API.
 * 2. Verifies the upstream accepted the upgrade (Status 101).
 * 3. Creates a `WebSocketPair` to bridge the client and the upstream server.
 * 4. Proxies the subprotocol negotiation (handling `Sec-WebSocket-Protocol` is
 *    critical for `kubectl` compatibility).
 * 5. Delegates the actual message piping to `setupProxy`.
 *
 * @param request - The original HTTP Upgrade request.
 * @param k8sIdentity - The identity attributes used to generate
 * `Impersonate-User` and `Impersonate-Group` headers.
 * @returns A `101 Switching Protocols` response containing the client-side
 * WebSocket, or an error response.
 */
async function handleStreamingUpgrade(
  request: Request,
  k8sIdentity: K8sIdentity,
): Promise<Response> {
  const context = getContext();

  const url = new URL(request.url);
  logSystem(
    "debug",
    `Proxying WebSocket ${JSON.stringify(request.method)} ${JSON.stringify(url.pathname)}`,
  );

  // Build headers
  const headers = buildKubeHeaders(request, k8sIdentity);
  const targetUrl = new URL(
    `${context.KUBE_API_SERVER}${url.pathname}${url.search}`,
  );

  try {
    const start = performance.now();
    const kubeWsResponse = await context.KUBE_API.fetch(targetUrl, {
      headers: headers,
    });
    const end = performance.now();
    const durationMs = end - start;

    if (kubeWsResponse.status !== 101) {
      logSystem(
        "error",
        `Kubernetes WebSocket upgrade failed: ${kubeWsResponse.status}`,
      );

      // Log k8s log
      const context = getContext();
      await logK8sHttp(
        request,
        kubeWsResponse.status,
        k8sIdentity,
        {
          upstreamLatencyMs: durationMs,
          response: kubeWsResponse,
        },
        context,
      );

      return new Response(
        `Kubernetes WebSocket upgrade failed: ${kubeWsResponse.status}`,
        {
          status: kubeWsResponse.status,
        },
      );
    }

    const kubeServerWebSocket = kubeWsResponse.webSocket;
    if (!kubeServerWebSocket) {
      logSystem("error", "No WebSocket in response");
      return new Response("WebSocket upgrade failed", {
        status: 500,
      });
    }

    // Create WebSocket pair
    const websocketPair = new WebSocketPair();
    const [client, server] = Object.values(websocketPair);

    // Accept the WebSocket connection from client (kubectl)
    server.accept();
    // Accept the WebSocket connection from the Kube API server
    kubeServerWebSocket.accept();
    logSystem("debug", "WebSocket connection established successfully");

    // Set up hooks and piping logic
    setupProxy(
      request,
      kubeWsResponse,
      k8sIdentity,
      server,
      kubeServerWebSocket,
      context,
    );
    logSystem("debug", "WebSocket piping established");

    const responseHeaders = new Headers();
    responseHeaders.set("Upgrade", "websocket");
    responseHeaders.set("Connection", "Upgrade");
    // Check if the Origin agreed to a subprotocol
    const acceptedProtocol = kubeWsResponse.headers.get(
      "Sec-WebSocket-Protocol",
    );
    if (acceptedProtocol) {
      responseHeaders.set("Sec-WebSocket-Protocol", acceptedProtocol);
    }

    return new Response(null, {
      status: 101,
      statusText: "Switching protocols",
      webSocket: client,
      headers: responseHeaders,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    logSystemError("WebSocket setup error", error);
    return new Response(`WebSocket setup failed: ${message}`, { status: 500 });
  }
}

/**
 * Pipes data between the Client and the Origin with hooks.
 * @param {Request} request - Request sent by client.
 * @param {Response} response - WebSocket Upgrade response containing websocket.
 * @param {K8sIdentity} k8sIdentity - The K8s identity that was impersonated.
 * @param {WebSocket} kubeClientWS - Connection to the downstream user's Kube
 * client
 * @param {WebSocket} kubeServerWS - Connection to the upstream Kube server
 * @param {WorkerContext} workerContext - The Worker context.
 */
function setupProxy(
  request: Request,
  response: Response,
  k8sIdentity: K8sIdentity,
  kubeClientWS: WebSocket,
  kubeServerWS: WebSocket,
  workerContext: WorkerContext,
) {
  // State tracking of websocket proxying
  const start = performance.now();
  let received = 0;
  let sent = 0;
  let errorMsg: string | undefined;
  let isLogged = false; // Prevent double logging

  // Helper to safely send message
  const safeSend = (
    socket: WebSocket,
    data: string | ArrayBuffer | ArrayBufferView<ArrayBufferLike>,
  ) => {
    if (socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(data);
      } catch (err) {
        logSystemError(
          "WS Error: Failed to send message",
          err,
          undefined,
          workerContext,
        );
      }
    } else {
      logSystem(
        "warn",
        `WS Warning: Socket not open, state: ${socket.readyState}`,
        undefined,
        workerContext,
      );
    }
  };

  // Helper to safely close websocket
  const safeClose = (socket: WebSocket, code = 1000, reason = "") => {
    // If WebSocket is already closed/closing, do nothing
    if (
      socket.readyState === WebSocket.CLOSED ||
      socket.readyState === WebSocket.CLOSING
    ) {
      return;
    }

    // Sanitize Reserved WebSocket Codes
    //
    // 1005: No Status Recvd
    // 1006: Abnormal Closure
    // 1015: TLS Handshake
    if (code === 1005 || code === 1006 || code === 1015) {
      // Fallback to 1001 (Going Away)
      code = 1001;
    }

    try {
      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) {
        socket.close(code, reason);
      }
    } catch (err) {
      // Ignore errors during close
      logSystemError(
        "Got error when closing WebSocket",
        err,
        undefined,
        workerContext,
      );
    }
  };

  // Helper to flush final log on websocket close
  const finish = (closeDetails: string) => {
    if (isLogged) return; // Ensure we only log once per session
    isLogged = true;

    // Log k8s log
    logK8sWebSocket(
      request,
      response.status,
      k8sIdentity,
      {
        protocol: "websocket",
        durationMs: performance.now() - start,
        bytesReceived: received,
        bytesSent: sent,
        disconnectReason: closeDetails,
        websocketError: errorMsg,
      },
      workerContext,
    );
  };

  // Helper to calculate size of websocket message
  const getSize = (data: string | ArrayBuffer): number => {
    if (typeof data === "string") {
      return data.length;
    }
    return data.byteLength;
  };

  // --- KubeClient TO KubeServer ---
  kubeClientWS.addEventListener("message", (event) => {
    // Measure bytes received from client and sent to KubeServer
    received += getSize(event.data);
    safeSend(kubeServerWS, event.data);
  });

  // --- KubeServer TO KubeClient ---
  kubeServerWS.addEventListener("message", (event) => {
    // Measure bytes received from KubeServer and sent to KubeClient
    sent += getSize(event.data);
    safeSend(kubeClientWS, event.data);
  });

  // --- ERROR HANDLING & CLOSURE ---
  // Hook: Error (KubeClient)
  kubeClientWS.addEventListener("error", (err) => {
    errorMsg = `KubeClient WS Error: ${err.message || "Unknown"}`;
    logSystemError(
      "WS Error (KubeClient side)",
      err.error,
      undefined,
      workerContext,
    );
    safeClose(kubeServerWS);
  });
  // Hook: Error (KubeServer)
  kubeServerWS.addEventListener("error", (err) => {
    errorMsg = `KubeServer WS Error: ${err.message || "Unknown"}`;
    logSystemError(
      "WS Error (KubeServer side)",
      err.error,
      undefined,
      workerContext,
    );
    safeClose(kubeClientWS);
  });
  // Close forwarding
  kubeClientWS.addEventListener("close", (event) => {
    const closeDetails = `KubeClient closed WebSocket: [${event.code}]`;
    logSystem(
      "debug",
      closeDetails,
      {
        code: event.code,
        reason: event.reason,
      },
      workerContext,
    );
    safeClose(kubeServerWS, event.code, "KubeClient closed WebSocket");
    finish(closeDetails);
  });
  kubeServerWS.addEventListener("close", (event) => {
    const closeDetails = `KubeServer closed WebSocket: [${event.code}]`;
    logSystem(
      "debug",
      closeDetails,
      {
        code: event.code,
        reason: event.reason,
      },
      workerContext,
    );
    safeClose(kubeClientWS, event.code, "KubeServer closed WebSocket");
    finish(closeDetails);
  });
}

/**
 * Constructs the HTTP headers required for an authenticated request to the
 * Kubernetes API.
 *
 * This function performs a critical security transformation:
 * 1. Sanitizes the incoming headers to remove client-injected impersonation
 *    headers.
 * 2. Injects `Impersonate-User` and `Impersonate-Group` headers based on the
 *    resolved identity.
 * @param request - The original incoming request.
 * @param k8sIdentity - The target identity to impersonate.
 * @returns A sanitized and augmented `Headers` object ready for the upstream
 * API.
 * @throws {Error} If `k8sIdentity.user` is missing, as this would default to
 * the Service Account's own privileges (escalation risk).
 */
function buildKubeHeaders(request: Request, k8sIdentity: K8sIdentity): Headers {
  const headers = new Headers(request.headers);
  sanitizeHeaders(headers);

  // Delete "Authorization" header that user's kubectl provided. We want
  // upstream kubectl proxy to use its service account token to perform
  // impersonation
  deleteHeader(headers, "Authorization");

  // Safety! Otherwise, they'll get whatever permissions the SA token has
  if (!k8sIdentity.user) {
    throw new Error("missing k8s username to impersonate");
  }

  // Add impersonation headers
  headers.set("Impersonate-User", k8sIdentity.user);
  for (const group of k8sIdentity.groups) {
    headers.append("Impersonate-Group", group);
  }
  headers.append("Impersonate-Group", "system:authenticated");

  return headers;
}

/**
 * Removes sensitive, conflicting, or potentially dangerous headers from the
 * request.
 *
 * This acts as a security boundary to prevent:
 * 1. **Header Injection:** Users manually sending `Impersonate-*` headers to
 *    bypass authentication.
 * 2. **Leakage:** Passing internal Cloudflare headers (like `cf-connecting-ip`
 *    or the raw JWT) to the upstream API.
 *
 * @param headers - The Headers object to mutate in place.
 * @see
 * {@link https://kubernetes.io/docs/reference/access-authn-authz/authentication/#user-impersonation | K8s Impersonation Docs}
 * @see {@link https://developers.cloudflare.com/fundamentals/reference/http-headers/ | Standard Cloudflare HTTP Headers}
 */
function sanitizeHeaders(headers: Headers): void {
  // Don't permit user-specified, extra impersonation headers
  //
  // Remove "Impersonate-*" headers
  for (const headerName of headers.keys()) {
    if (headerName.toLowerCase().startsWith("impersonate-")) {
      deleteHeader(headers, headerName);
    }
  }

  // Remove Cloudflare Headers
  const cfHeaders = [
    "x-real-ip",
    "x-forwarded-proto",
    "cookie",
    "cf-visitor",
    "cf-ray",
    "cf-ipcountry",
    "cf-connecting-ip",
    "cf-access-jwt-assertion",
    "cf-access-authenticated-user-email",
  ];
  cfHeaders.forEach((header) => deleteHeader(headers, header));
}

/**
 * Utility to safely delete a header if it exists.
 *
 * @param headers - The Headers object to modify.
 * @param key - The case-insensitive header name to remove.
 */
function deleteHeader(headers: Headers, key: string): void {
  const value = headers.get(key);
  if (value) {
    headers.delete(key);
  }
}

/**
 * Resolves a Cloudflare Access Application JWT `email` claim to a Kubernetes
 * Identity.
 *
 * This function checks the static `IDENTITY_MAP` for a match.
 *
 * @param claims - The verified claims from the Cloudflare Access JWT.
 * @returns The matching {@link K8sIdentity}, or `null` if the user is not
 * authorized for the cluster.
 *
 * @warning **DEMO LOGIC:** The current implementation grants `system:masters`
 * (superuser) privileges to ANY user with a `@mydomain.com` email address.
 * This should be removed or replaced with a proper lookup in production.
 */
function mapAccessIdentityToK8s(claims: AccessJwtClaims): K8sIdentity | null {
  // TODO: Remove this. This is for demo purposes. Gives everybody with
  // @mydomain email in your Zero Trust org, superuser privileges
  if (claims.email.endsWith("@mydomain.com")) {
    return {
      accessJwtIdentity: claims.email,
      // Does not matter since group is superuser, but still required for
      // impersonation to specify username
      user: "foobar",
      groups: ["system:masters"],
    };
  }

  const mapping = IDENTITY_MAP[claims.email];
  if (!mapping) {
    return null;
  }
  return mapping;
}
