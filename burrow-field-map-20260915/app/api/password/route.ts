import {
  clearPasswordSessionCookie,
  createPasswordSessionCookie,
  isPasswordConfigured,
  isPasswordSessionValid,
  verifyPassword,
} from "../../password-session";

function jsonResponse(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return Response.json(body, { ...init, headers });
}

export async function GET(request: Request) {
  return jsonResponse({
    authenticated: await isPasswordSessionValid(request),
    configured: isPasswordConfigured(),
  });
}

export async function POST(request: Request) {
  try {
    if (!isPasswordConfigured()) {
      return jsonResponse(
        { error: "アプリのパスワードが未設定です。" },
        { status: 503 },
      );
    }

    const payload = (await request.json()) as { password?: unknown };
    if (!(await verifyPassword(payload.password))) {
      return jsonResponse({ error: "パスワードが違います。" }, { status: 401 });
    }

    return jsonResponse(
      { authenticated: true },
      { headers: { "Set-Cookie": await createPasswordSessionCookie(request) } },
    );
  } catch {
    return jsonResponse({ error: "パスワードを確認できませんでした。" }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  return jsonResponse(
    { authenticated: false },
    { headers: { "Set-Cookie": clearPasswordSessionCookie(request) } },
  );
}
