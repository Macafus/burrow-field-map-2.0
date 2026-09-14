interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

interface D1Database {
  batch(statements: D1PreparedStatement[]): Promise<unknown[]>;
  prepare(query: string): D1PreparedStatement;
}

declare module "cloudflare:workers" {
  export const env: Record<string, unknown> & {
    APP_PASSWORD?: string;
    DB?: D1Database;
  };
}
