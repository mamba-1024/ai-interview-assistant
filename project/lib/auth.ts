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

export async function login(): Promise<void> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  const authUrl = new URL(AUTH_CONFIG.authUrl);
  authUrl.searchParams.set("client_id", AUTH_CONFIG.clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", AUTH_CONFIG.redirectUrl);
  authUrl.searchParams.set("scope", AUTH_CONFIG.scopes.join(" "));
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", crypto.randomUUID());

  const responseUrl = await chrome.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive: true,
  });

  const url = new URL(responseUrl);
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

  const tokens = await tokenResponse.json();

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
    const response = await fetch(AUTH_CONFIG.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: session.refreshToken,
        client_id: AUTH_CONFIG.clientId,
      }),
    });
    const tokens = await response.json();
    await chrome.storage.session.set({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
    });
    return tokens.access_token;
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
