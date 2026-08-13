import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { outlets } from "./org";
import { invoices, returns } from "./orders";
import { purchaseBills } from "./purchasing";

export const payments = sqliteTable(
  "payments",
  {
    id: text("id").primaryKey(),
    paymentNumber: text("paymentNumber").notNull(),
    direction: text("direction").notNull(),
    partyType: text("partyType").notNull(),
    partyId: text("partyId").notNull(),
    invoiceId: text("invoiceId").references(() => invoices.id, { onDelete: "restrict" }),
    purchaseBillId: text("purchaseBillId").references(() => purchaseBills.id, { onDelete: "restrict" }),
    returnId: text("returnId").references(() => returns.id, { onDelete: "restrict" }),
    outletId: text("outletId").references(() => outlets.id, { onDelete: "restrict" }).notNull(),
    amountPaise: integer("amountPaise").notNull(),
    mode: text("mode").notNull(),
    gateway: text("gateway"),
    gatewayPaymentId: text("gatewayPaymentId"),
    gatewayEventId: text("gatewayEventId"),
    status: text("status").notNull(),
    createdAt: integer("createdAt").notNull(),
  },
  (t) => [
    uniqueIndex("payments_payment_number_unique").on(t.paymentNumber),
    uniqueIndex("payments_gateway_event_unique")
      .on(t.gateway, t.gatewayEventId)
      .where(sql`${t.gateway} IS NOT NULL`),
    index("payments_party_idx").on(t.partyType, t.partyId),
    index("payments_invoice_idx").on(t.invoiceId),
    index("payments_purchase_bill_idx").on(t.purchaseBillId),
  ],
);
