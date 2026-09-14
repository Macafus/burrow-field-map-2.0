import { ensureDatabase, getD1 } from "../../../db";
import { isPasswordSessionValid } from "../../password-session";

const STATE_ID = "main";
const MAX_STATE_BYTES = 4_000_000;

type StoredRow = {
  data: string;
  revision: number;
  updated_at: string;
};

function isAppData(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return Array.isArray(state.burrows) && Array.isArray(state.strokes) && Array.isArray(state.memos);
}

function isSharedState(value: unknown) {
  if (isAppData(value)) return true;
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return (
    Array.isArray(state.projects) &&
    state.projects.length > 0 &&
    state.projects.every((item) => {
      if (!item || typeof item !== "object") return false;
      const project = item as Record<string, unknown>;
      return (
        typeof project.id === "string" &&
        typeof project.name === "string" &&
        (project.note === undefined || typeof project.note === "string") &&
        (project.year === undefined ||
          (typeof project.year === "number" &&
            Number.isInteger(project.year) &&
            project.year >= 1900 &&
            project.year <= 2100)) &&
        typeof project.updatedAt === "string" &&
        isAppData(project.data)
      );
    })
  );
}

function jsonResponse(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return Response.json(body, { ...init, headers });
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const revisionOnly = new URL(request.url).searchParams.get("revisionOnly") === "1";
    if (revisionOnly) {
      const revisionRow = await getD1()
        .prepare("SELECT revision, updated_at FROM app_states WHERE id = ?")
        .bind(STATE_ID)
        .first<Pick<StoredRow, "revision" | "updated_at">>();
      return jsonResponse({
        revision: revisionRow?.revision ?? 0,
        updatedAt: revisionRow?.updated_at ?? null,
      });
    }

    const row = await getD1()
      .prepare("SELECT data, revision, updated_at FROM app_states WHERE id = ?")
      .bind(STATE_ID)
      .first<StoredRow>();

    if (!row) return jsonResponse({ state: null, revision: 0, updatedAt: null });

    const state = JSON.parse(row.data) as unknown;
    if (!isSharedState(state)) {
      return jsonResponse({ error: "共有データの形式が正しくありません。" }, { status: 500 });
    }

    return jsonResponse({ state, revision: row.revision, updatedAt: row.updated_at });
  } catch (error) {
    const message = error instanceof Error ? error.message : "共有データを読み込めませんでした。";
    return jsonResponse({ error: message }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    if (!(await isPasswordSessionValid(request))) {
      return jsonResponse({ error: "パスワードの確認が必要です。" }, { status: 401 });
    }

    const payload = (await request.json()) as { state?: unknown };
    if (!isSharedState(payload.state)) {
      return jsonResponse({ error: "state is required" }, { status: 400 });
    }

    const serialized = JSON.stringify(payload.state);
    if (new TextEncoder().encode(serialized).byteLength > MAX_STATE_BYTES) {
      return jsonResponse({ error: "共有データが大きすぎます。" }, { status: 413 });
    }

    await ensureDatabase();
    const row = await getD1()
      .prepare(`
        INSERT INTO app_states (id, data, revision, updated_at)
        VALUES (?, ?, 1, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
          data = excluded.data,
          revision = app_states.revision + 1,
          updated_at = CURRENT_TIMESTAMP
        RETURNING revision, updated_at
      `)
      .bind(STATE_ID, serialized)
      .first<{ revision: number; updated_at: string }>();

    return jsonResponse({
      revision: row?.revision ?? 1,
      updatedAt: row?.updated_at ?? new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "共有データを保存できませんでした。";
    return jsonResponse({ error: message }, { status: 500 });
  }
}
