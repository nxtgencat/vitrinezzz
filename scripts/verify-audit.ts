import { readFileSync } from "node:fs";
import { join } from "node:path";

const log = (await import("../lib/logger")).logger.child({ module: "verify-audit" });
const failures: string[] = [];

/**
 * Every mutating route must write an `audit_events` row for the entity it
 * mutates, from the owning domain service — never from the route layer
 * (`architecture.md` §4.6/§4.11, `audit.md` §2). This table maps each route
 * to the service file that implements it and the entityType(s) the service
 * must emit. It grows one row per phase, in the same commit as the routes.
 */
const AUDITED_MUTATIONS: {
  route: string;
  serviceFile: string;
  entityTypes: string[];
}[] = [
  { route: "PUT /api/staff/:id/deactivate", serviceFile: "services/staff.ts", entityTypes: ["staff"] },
  { route: "POST /api/categories", serviceFile: "services/catalog.ts", entityTypes: ["category"] },
  { route: "PUT /api/categories/:id", serviceFile: "services/catalog.ts", entityTypes: ["category"] },
  { route: "POST /api/products", serviceFile: "services/catalog.ts", entityTypes: ["product", "variant"] },
  { route: "PUT /api/products/:id", serviceFile: "services/catalog.ts", entityTypes: ["product"] },
  { route: "POST /api/products/:id/deactivate", serviceFile: "services/catalog.ts", entityTypes: ["product"] },
  { route: "POST /api/variants", serviceFile: "services/catalog.ts", entityTypes: ["variant"] },
  { route: "PUT /api/variants/:id", serviceFile: "services/catalog.ts", entityTypes: ["variant"] },
  { route: "POST /api/inventory/batches", serviceFile: "services/stock.ts", entityTypes: ["batch"] },
  { route: "POST /api/vendors", serviceFile: "services/purchasing.ts", entityTypes: ["vendor"] },
  { route: "POST /api/purchase-bills/:id/issue", serviceFile: "services/purchasing.ts", entityTypes: ["batch"] },
  { route: "POST /api/products/:id/media", serviceFile: "services/media.ts", entityTypes: ["media"] },
  { route: "POST /api/variants/:id/media", serviceFile: "services/media.ts", entityTypes: ["media"] },
  { route: "DELETE /api/media/:id", serviceFile: "services/media.ts", entityTypes: ["media"] },
];

for (const entry of AUDITED_MUTATIONS) {
  const abs = join(process.cwd(), entry.serviceFile);
  const content = readFileSync(abs, "utf8");
  const hasWriteCall = /writeAuditEvent\(/.test(content);
  if (!hasWriteCall) {
    failures.push(`${entry.route}: ${entry.serviceFile} never calls writeAuditEvent`);
    continue;
  }
  for (const entityType of entry.entityTypes) {
    const emitted = new RegExp(`entityType: "\\b${entityType}\\b"`).test(content);
    if (!emitted) {
      failures.push(`${entry.route}: ${entry.serviceFile} never emits entityType "${entityType}"`);
    }
  }
}

if (failures.length > 0) {
  log.error({ failures: failures.length, first: failures[0], all: failures }, "verify-audit FAILED");
  process.exit(1);
}
log.info({ routes: AUDITED_MUTATIONS.length }, "verify-audit PASS");
