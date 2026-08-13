import { randomUUIDv7 } from "bun";
import { eq } from "drizzle-orm";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { invoices } from "../db/schema/orders";
import { withTx } from "./db";
import { logger } from "./logger";

export const PDF_HTML_MAX_BYTES = 256 * 1024;

const pdfDir = join(process.env.STORAGE_DIR ?? join("data", "storage"), "pdfs");

/**
 * In-process PDF printer (`architecture.md` §4.9): the backend never composes
 * invoice HTML — the client builds the markup and posts it; the server only
 * prints via `Bun.WebView` (chrome backend, CDP `Page.printToPDF` — the
 * WebKit backend has no CDP bridge and cannot print).
 *
 * **Non-fatal by design.** A missing Chrome binary, a failed navigate, or a
 * failed print is caught, logged at `warn`, and leaves `pdfPath` null — the
 * parent request never fails because of a printing problem, and the route is
 * safely re-callable to retry. One print runs at a time through a small
 * in-process queue; volume is per-invoice, human-scale, never a hot path.
 *
 * The invoice's `pdfPath` is set in a small, separate transaction after the
 * file write succeeds — printing is never inside the transaction that issued
 * the invoice, because an invoice must exist regardless of whether a browser
 * is available to render it.
 */

let queue: Promise<string | null> = Promise.resolve(null);

/**
 * Renders `html` to a PDF for the invoice and records the file path. Resolves
 * with the absolute `pdfPath` on success, `null` on any failure — never
 * throws past its own catch.
 */
export function renderInvoicePdf(invoiceId: string, html: string): Promise<string | null> {
  if (html.length > PDF_HTML_MAX_BYTES) {
    logger.warn({ invoiceId, bytes: html.length }, "pdf html exceeds 256KB — pdfPath stays null");
    return Promise.resolve(null);
  }
  const run = queue.then(() => printPdf(invoiceId, html));
  queue = run;
  return run;
}

async function printPdf(invoiceId: string, html: string): Promise<string | null> {
  const path = join(pdfDir, `${invoiceId}-${randomUUIDv7()}.pdf`);
  let view: Bun.WebView | null = null;
  try {
    view = new Bun.WebView({ backend: "chrome", headless: true });
    await view.navigate("data:text/html;charset=utf-8," + encodeURIComponent(html));
    const result = await view.cdp<{ data: string }>("Page.printToPDF", {
      printBackground: true,
      format: "A4",
      preferCSSPageSize: true,
    });
    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(path, Buffer.from(result.data, "base64"));
    view.close();
    view = null;
  } catch (err) {
    logger.warn({ err, invoiceId }, "pdf render failed — pdfPath stays null");
    if (view) {
      try {
        view.close();
      } catch {
        // best-effort cleanup — the failure is already non-fatal
      }
    }
    return null;
  }
  try {
    await withTx((tx) => {
      tx.update(invoices).set({ pdfPath: path }).where(eq(invoices.id, invoiceId)).run();
    });
  } catch (err) {
    logger.warn({ err, invoiceId }, "pdf file written but pdfPath update failed");
    return null;
  }
  return path;
}