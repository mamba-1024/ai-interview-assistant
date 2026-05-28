/**
 * OAuth2 PKCE 认证流程
 */

const AUTH_CONFIG = {
  authUrl: "https://api.yourapp.com/oauth/authorize",
  tokenUrl: "https://api.yourapp.com/oauth/token",
  redirectUrl: chrome.identity?.getRedirectURL?.("oauth-callback") ?? "",
  clientId: "YOUR_OAUTH_CLIENT_ID",
  scopes: ["openid", "profile", "email"],
};

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type?: string;
}

function validateTokenResponse(data: unknown): TokenResponse {
  if (!data || typeof data !== "object") {
    throw new Error("Invalid token response: not an object");
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj.access_token !== "string" || !obj.access_token) {
    throw new Error("Invalid token response: missing access_token");
  }
  if (typeof obj.expires_in !== "number" || obj.expires_in <= 0) {
    // 降级：默认 1 小时过期
    obj.expires_in = 3600;
  }
  return obj as unknown as TokenResponse;
}

export async function login(): Promise<void> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  // 生成并保存 state 参数（CSRF 防护）
  const state = crypto.randomUUID();

  const authUrl = new URL(AUTH_CONFIG.authUrl);
  authUrl.searchParams.set("client_id", AUTH_CONFIG.clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", AUTH_CONFIG.redirectUrl);
  authUrl.searchParams.set("scope", AUTH_CONFIG.scopes.join(" "));
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);

  const responseUrl = await chrome.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive: true,
  });

  if (!responseUrl) throw new Error("No response URL received from auth flow");

  const url = new URL(responseUrl);

  // 验证 state 参数以防止 CSRF 攻击
  const returnedState = url.searchParams.get("state");
  if (returnedState !== state) {
    throw new Error("OAuth state mismatch — possible CSRF attack");
  }

  // 检查是否有错误返回
  const error = url.searchParams.get("error");
  if (error) {
    const description = url.searchParams.get("error_description") ?? error;
    throw new Error(`OAuth error: ${description}`);
  }

  const code = url.searchParams.get("code");
  if (!code) throw new Error("No authorization code received");

  const tokenResponse = await fetch(AUTH_CONFIG.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: AUTH_CONFIG.redirectUrl,
      code_verifier: codeVerifier,
      client_id: AUTH_CONFIG.clientId,
    }),
  });

  if (!tokenResponse.ok) {
    const body = await tokenResponse.text().catch(() => "");
    throw new Error(`Token exchange failed (${tokenResponse.status}): ${body}`);
  }

  const tokens = validateTokenResponse(await tokenResponse.json());

  await chrome.storage.session.set({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  });
}

export async function getValidToken(): Promise<string> {
  const session = await chrome.storage.session.get([
    "accessToken",
    "refreshToken",
    "expiresAt",
  ]);

  if (
    session.expiresAt &&
    Date.now() > (session.expiresAt as number) - 5 * 60 * 1000
  ) {
    if (!session.refreshToken) {
      throw new Error("Token expired and no refresh token available");
    }

    const response = await fetch(AUTH_CONFIG.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: session.refreshToken,
        client_id: AUTH_CONFIG.clientId,
      }),
    });

    if (!response.ok) {
      // 刷新失败，清除无效 token
      await chrome.storage.session.remove(["accessToken", "refreshToken", "expiresAt"]);
      throw new Error(`Token refresh failed (${response.status})`);
    }

    const tokens = validateTokenResponse(await response.json());
    await chrome.storage.session.set({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? session.refreshToken,
      expiresAt: Date.now() + tokens.expires_in * 1000,
    });
    return tokens.access_token;
  }

  if (!session.accessToken) {
    throw new Error("No access token available");
  }

  return session.accessToken as string;
}

export async function logout(): Promise<void> {
  await chrome.storage.session.remove([
    "accessToken",
    "refreshToken",
    "expiresAt",
  ]);
}

function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}
