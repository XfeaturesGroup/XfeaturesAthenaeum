/**
 * Nothing here is a secret. This CLI is a *public* OAuth client (RFC 6749
 * §2.1, RFC 8252): it is distributed to end users, so it holds no
 * client_secret and could not keep one if it tried. The token exchange is
 * authenticated by PKCE alone — a fresh code_verifier per login, generated in
 * this process and never transmitted until the final exchange.
 *
 * A client_id is public by design in OAuth 2.0; it names the application, it
 * does not authenticate it.
 */
export interface CliConfig {
	accountWebUrl: string;
	accountApiUrl: string;
	athenaeumBaseUrl: string;
	clientId: string;
	redirectUri: string;
	scope: string;
}

/**
 * The production "Athenaeum Developer Access" application. Shipping it as the
 * default is deliberate: a client_id names an application, it does not
 * authenticate one, and requiring every user to be told this string before
 * `athenaeum login` works buys no security -- it only guarantees the first
 * attempt fails. Override it to point the CLI at another deployment.
 */
const DEFAULT_CLIENT_ID = "xf_c2c41345139f4acd91bf95ced0f3004e";

export function loadConfig(): CliConfig {
	return {
		accountWebUrl: process.env["ATHENAEUM_ACCOUNT_WEB_URL"] ?? "https://account.xfeatures.net",
		accountApiUrl: process.env["ATHENAEUM_ACCOUNT_API_URL"] ?? "https://api.account.xfeatures.net",
		athenaeumBaseUrl: process.env["ATHENAEUM_BASE_URL"] ?? "https://athenaeum.xfeatures.net",
		clientId: process.env["ATHENAEUM_CLIENT_ID"] ?? DEFAULT_CLIENT_ID,
		redirectUri: process.env["ATHENAEUM_REDIRECT_URI"] ?? "http://localhost:8765/callback",
		scope: process.env["ATHENAEUM_SCOPE"] ?? "openid profile:username email"
	};
}
