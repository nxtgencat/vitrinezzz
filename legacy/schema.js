import PocketBase from 'pocketbase';
import 'dotenv/config'

// ========================================
//           FIELD BUILDERS
// ========================================

let fieldId = 0;

const text = (name, options = {}) => ({
    type: 'text', name, id: `text_${++fieldId}`,
    max: options.max || 0, min: 0,
    required: options.required || false,
    presentable: options.presentable || false,
    autogeneratePattern: '', pattern: '',
    hidden: false, primaryKey: false, system: false,
});

const number = (name, options = {}) => ({
    type: 'number', name, id: `number_${++fieldId}`,
    max: options.max ?? null, min: options.min ?? 0,
    required: options.required || false,
    onlyInt: options.integer || false,
    hidden: false, presentable: false, system: false,
});

const bool = (name) => ({
    type: 'bool', name, id: `bool_${++fieldId}`,
    required: false, hidden: false, presentable: false, system: false,
});

const date = (name, options = {}) => ({
    type: 'date', name, id: `date_${++fieldId}`,
    max: '', min: '',
    required: options.required || false,
    hidden: false, presentable: false, system: false,
});

const email = (name) => ({
    type: 'email', name, id: `email_${++fieldId}`,
    exceptDomains: null, onlyDomains: null,
    required: false, hidden: false, presentable: false, system: false,
});

const select = (name, values, options = {}) => ({
    type: 'select', name, id: `select_${++fieldId}`,
    values, maxSelect: 1,
    required: options.required || false,
    hidden: false, presentable: false, system: false,
});

const relation = (name, collectionId, options = {}) => ({
    type: 'relation', name, id: `relation_${++fieldId}`,
    collectionId,
    maxSelect: 1,
    minSelect: options.required ? 1 : 0,
    required: options.required || false,
    cascadeDelete: options.cascadeDelete || false,
    hidden: false, presentable: false, system: false,
});

const file = (name, options = {}) => ({
    type: 'file', name, id: `file_${++fieldId}`,
    maxSelect: 1, maxSize: 5242880,
    mimeTypes: options.mimeTypes || [],
    thumbs: [], required: false, protected: false,
    hidden: false, presentable: false, system: false,
});

const json = (name) => ({
    type: 'json', name, id: `json_${++fieldId}`,
    maxSize: 0, required: false,
    hidden: false, presentable: false, system: false,
});

const url = (name) => ({
    type: 'url', name, id: `url_${++fieldId}`,
    exceptDomains: null, onlyDomains: null,
    required: false, hidden: false, presentable: false, system: false,
});

// ========================================
//           SYSTEM FIELDS
// ========================================

const systemId = () => ({
    type: 'text', name: 'id', id: `text_id_${++fieldId}`,
    autogeneratePattern: '[a-z0-9]{15}',
    pattern: '^[a-z0-9]+$',
    max: 15, min: 15, required: true,
    primaryKey: true, system: true, hidden: false, presentable: false,
});

const autoCreated = () => ({
    type: 'autodate', name: 'created', id: `autodate_${++fieldId}`,
    onCreate: true, onUpdate: false,
    hidden: false, presentable: false, system: false,
});

const autoUpdated = () => ({
    type: 'autodate', name: 'updated', id: `autodate_${++fieldId}`,
    onCreate: true, onUpdate: true,
    hidden: false, presentable: false, system: false,
});

const deletedAt = () => date('deleted_at');

// ========================================
//         COMMON HELPERS
// ========================================

const orgField = () => relation('organisation', 'pbc_organisations', { required: true });

// ========================================
//         COLLECTION BUILDER
// ========================================

const collection = (name, fields, options = {}) => ({
    id: `pbc_${name}`,
    name,
    type: 'base',
    system: false,
    listRule: options.listRule ?? '@request.auth.id != ""',
    viewRule: options.viewRule ?? '@request.auth.id != ""',
    createRule: options.createRule ?? '@request.auth.id != ""',
    updateRule: options.updateRule ?? '@request.auth.id != ""',
    deleteRule: options.deleteRule ?? '@request.auth.id != ""',
    fields: [
        systemId(),
        ...fields,
        autoCreated(),
        autoUpdated(),
        ...(options.noSoftDelete ? [] : [deletedAt()]),
    ],
    indexes: options.indexes || [],
});

// ========================================
//      AUTH COLLECTION BUILDER
// ========================================

const authSystemFields = () => [
    {
        autogeneratePattern: '[a-z0-9]{15}', hidden: false, id: `text_${++fieldId}`,
        max: 15, min: 15, name: 'id', pattern: '^[a-z0-9]+$',
        presentable: false, primaryKey: true, required: true, system: true, type: 'text',
    },
    {
        cost: 0, hidden: true, id: `password_${++fieldId}`,
        max: 0, min: 8, name: 'password', pattern: '',
        presentable: false, required: true, system: true, type: 'password',
    },
    {
        autogeneratePattern: '[a-zA-Z0-9]{50}', hidden: true, id: `text_${++fieldId}`,
        max: 60, min: 30, name: 'tokenKey', pattern: '',
        presentable: false, primaryKey: false, required: true, system: true, type: 'text',
    },
    {
        exceptDomains: null, hidden: false, id: `email_${++fieldId}`,
        name: 'email', onlyDomains: null, presentable: false,
        required: true, system: true, type: 'email',
    },
    {
        hidden: false, id: `bool_${++fieldId}`, name: 'emailVisibility',
        presentable: false, required: false, system: true, type: 'bool',
    },
    {
        hidden: false, id: `bool_${++fieldId}`, name: 'verified',
        presentable: false, required: false, system: true, type: 'bool',
    },
];

const authCollection = (name, fields = [], options = {}) => ({
    id: options.id || `pbc_${name}`,
    name,
    type: 'auth',
    system: false,
    listRule: options.listRule ?? 'id = @request.auth.id',
    viewRule: options.viewRule ?? 'id = @request.auth.id',
    createRule: options.createRule ?? '',
    updateRule: options.updateRule ?? 'id = @request.auth.id',
    deleteRule: options.deleteRule ?? 'id = @request.auth.id',
    fields: [
        ...authSystemFields(),
        ...fields,
        autoCreated(),
        autoUpdated(),
    ],
    indexes: options.indexes || [
        `CREATE UNIQUE INDEX idx_tokenKey_${name} ON ${name} (tokenKey)`,
        `CREATE UNIQUE INDEX idx_email_${name} ON ${name} (email) WHERE email != ''`,
    ],
    authRule: '',
    manageRule: null,
    authAlert: {
        enabled: true,
        emailTemplate: {
            subject: 'Login from a new location',
            body: '<p>Hello,</p>\n<p>We noticed a login to your {APP_NAME} account from a new location.</p>\n<p><strong>If this wasn\'t you, change your password immediately.</strong></p>',
        },
    },
    oauth2: { mappedFields: { id: '', name: '', username: '', avatarURL: '' }, enabled: false },
    passwordAuth: { enabled: true, identityFields: ['email'] },
    mfa: { enabled: false, duration: 1800, rule: '' },
    otp: { enabled: false, duration: 180, length: 8, emailTemplate: { subject: 'OTP for {APP_NAME}', body: '<p>Your OTP: <strong>{OTP}</strong></p>' } },
    authToken: { duration: 604800 },
    passwordResetToken: { duration: 1800 },
    emailChangeToken: { duration: 1800 },
    verificationToken: { duration: 259200 },
    fileToken: { duration: 180 },
    verificationTemplate: {
        subject: 'Verify your {APP_NAME} email',
        body: '<p>Hello,</p>\n<p>Click below to verify your email address.</p>\n<p><a class="btn" href="{APP_URL}/_/#/auth/confirm-verification/{TOKEN}" target="_blank">Verify</a></p>',
    },
    resetPasswordTemplate: {
        subject: 'Reset your {APP_NAME} password',
        body: '<p>Hello,</p>\n<p>Click below to reset your password.</p>\n<p><a class="btn" href="{APP_URL}/_/#/auth/confirm-password-reset/{TOKEN}" target="_blank">Reset password</a></p>',
    },
    confirmEmailChangeTemplate: {
        subject: 'Confirm your {APP_NAME} new email',
        body: '<p>Hello,</p>\n<p>Click below to confirm your new email.</p>\n<p><a class="btn" href="{APP_URL}/_/#/auth/confirm-email-change/{TOKEN}" target="_blank">Confirm</a></p>',
    },
});

// ========================================
//         SCHEMA DEFINITIONS
// ========================================

const schema = [

    // ── 0. USERS (Auth) ──────────────────
    authCollection('users', [
        text('name', { max: 200 }),
        text('phone', { max: 20 }),
        relation('organisation', 'pbc_organisations'),
    ], { id: '_pb_users_auth_' }),

    // ── 1. ORGANISATIONS ─────────────────
    collection('organisations', [
        text('name', { required: true, presentable: true }),
        text('business_type', { max: 100 }),
        text('industry', { max: 100 }),
        text('address'),
        text('city', { max: 100 }),
        text('state', { max: 100 }),
        text('postal_code', { max: 20 }),
        text('country', { max: 100 }),
        text('phone', { max: 20 }),
        email('email'),
        text('website', { max: 255 }),
        text('gstin', { max: 15 }),
        text('pan', { max: 10 }),
        file('logo', { mimeTypes: ['image/jpeg', 'image/png', 'image/webp'] }),
        relation('base_currency', 'pbc_currencies'),
        number('fiscal_year_start_month', { min: 1, max: 12, integer: true }),
        text('timezone', { max: 50 }),
        text('date_format', { max: 20 }),
        text('default_terms'),
        number('business_margin_percent', { min: 0, max: 100 }),
        text('upi_id', { max: 200 }),
        text('whatsapp_device_id', { max: 100 }),
        text('whatsapp_pair_phone', { max: 30 }),
    ], { noSoftDelete: true }),

    // ── 1A. CURRENCIES ───────────────────
    collection('currencies', [
        text('code', { max: 3, required: true, presentable: true }),     // e.g., INR, USD
        text('symbol', { max: 5, required: true }),                      // e.g., ₹, $
        text('name', { max: 50, required: true }),                       // e.g., Indian Rupee
    ]),

    // ── 1B. PARTNERS / STAKEHOLDERS ──────
    collection('partners', [
        orgField(),
        text('name', { required: true, presentable: true }),
        email('email'),
        text('phone', { max: 20 }),
        date('start_date', { required: true }),
        date('end_date'),
        text('role', { max: 100 }),
        text('notes'),
        bool('is_active'),
    ]),

    // ── 2. TAX RATES ─────────────────────
    collection('tax_rates', [
        text('name', { max: 50, required: true, presentable: true }),
        number('rate', { min: 0, max: 100 }), // Removed required: true to allow 0
        text('description'),
    ]),

    // ── 3. ITEM GROUPS ───────────────────
    collection('item_groups', [
        orgField(),
        text('name', { required: true, presentable: true }),
        text('description'),
        number('business_margin_percent', { min: 0, max: 100 }),
    ]),

    // ── 4. ITEMS ─────────────────────────
    collection('items', [
        orgField(),
        text('name', { required: true, presentable: true }),
        text('sku', { max: 100, required: true }),
        select('type', ['inventory', 'service'], { required: true }),
        select('unit', ['PCS', 'DOZ', 'BOX', 'SET', 'PRS', 'UNT']),  // how you sell/count
        number('weight', { min: 0 }),  // quantity in weight_unit
        select('weight_unit', ['kg', 'g', 'lb', 'oz', 'L', 'mL', 'gal', 'm', 'cm', 'ft']),  // measurement unit
        text('hsn_code', { max: 50 }),
        relation('tax_rate', 'pbc_tax_rates'),
        number('selling_price', { min: 0, required: true }),
        number('purchase_price', { min: 0 }),
        number('mrp', { min: 0 }),
        bool('tax_inclusive'),
        number('opening_stock', { min: 0 }),
        number('current_stock'),
        number('reorder_level', { min: 0 }),
        relation('item_group', 'pbc_item_groups'),
        text('description'),
        number('business_margin_percent', { min: 0, max: 100 }),
        bool('is_purchasable'),
        bool('is_sellable'),
        file('image', { mimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] }),
        relation('parent_item', 'pbc_items'),
        bool('price_from_base'),
        json('nutrition_facts'),
    ], {
        indexes: [
            'CREATE INDEX idx_items_sku ON items (sku)',
        ],
    }),

    // ── 5. CUSTOMERS ─────────────────────
    collection('customers', [
        orgField(),
        select('customer_type', ['business', 'individual'], { required: true }),
        text('name', { required: true, presentable: true }),
        text('display_name', { required: true }),
        text('gstin', { max: 15 }),
        text('pan', { max: 10 }),
        text('billing_address'),
        text('shipping_address'),
        text('phone', { max: 20 }),
        email('email'),
        text('payment_terms', { max: 50 }),
        number('opening_balance'),
        number('current_balance'),
        text('notes'),
    ]),

    // ── 6. VENDORS ───────────────────────
    collection('vendors', [
        orgField(),
        text('name', { required: true, presentable: true }),
        text('display_name', { required: true }),
        text('gstin', { max: 15 }),
        text('pan', { max: 10 }),
        text('address'),
        text('phone', { max: 20 }),
        email('email'),
        text('payment_terms', { max: 50 }),
        text('bank_name', { max: 100 }),
        text('bank_account', { max: 50 }),
        text('bank_ifsc', { max: 20 }),
        number('opening_balance'),
        number('current_balance'),
        text('notes'),
    ]),

    // ── 7. INVOICES ──────────────────────
    collection('invoices', [
        orgField(),
        relation('customer', 'pbc_customers', { required: true }),
        text('invoice_number', { max: 50, required: true, presentable: true }),
        date('invoice_date', { required: true }),
        date('due_date'),
        text('payment_terms', { max: 50 }),
        number('subtotal', { min: 0 }),
        number('tax_amount', { min: 0 }),
        number('discount'),
        number('round_off'),
        json('extra_charges'),
        number('total', { min: 0 }),
        text('customer_notes'),
        text('terms'),
        select('status', ['draft', 'sent', 'paid', 'partial', 'overdue', 'void'], { required: true }),
        number('amount_paid', { min: 0 }),
        number('amount_due'),
    ], {
        indexes: [
            'CREATE UNIQUE INDEX idx_invoice_number ON invoices (invoice_number)',
        ],
    }),

    // ── 8. INVOICE ITEMS ─────────────────
    collection('invoice_items', [
        relation('invoice', 'pbc_invoices', { required: true, cascadeDelete: true }),
        relation('item', 'pbc_items', { required: true }),
        number('quantity', { min: 0, required: true }),
        number('rate', { min: 0, required: true }),
        number('cost_price', { min: 0 }),                   // purchase price snapshot at time of sale
        number('mrp', { min: 0 }),                           // MRP snapshot at time of sale
        number('discount', { min: 0 }),
        relation('tax_rate', 'pbc_tax_rates'),
        number('tax_amount', { min: 0 }),
        number('amount', { min: 0, required: true }),
    ], { noSoftDelete: true }),

    // ── 9. PAYMENTS RECEIVED ─────────────
    collection('payments_received', [
        orgField(),
        text('payment_number', { max: 50, required: true, presentable: true }),
        relation('customer', 'pbc_customers', { required: true }),
        relation('invoice', 'pbc_invoices'),
        number('amount', { min: 0, required: true }),
        date('payment_date', { required: true }),
        select('payment_mode', ['cash', 'cheque', 'bank_transfer', 'upi', 'card'], { required: true }),
        text('deposit_to', { max: 100 }),
        text('reference_number', { max: 100 }),
        text('notes'),
    ]),

    // ── 10. CREDIT NOTES ─────────────────
    collection('credit_notes', [
        orgField(),
        relation('customer', 'pbc_customers', { required: true }),
        text('credit_note_number', { max: 50, required: true, presentable: true }),
        date('credit_note_date', { required: true }),
        relation('invoice', 'pbc_invoices'),
        number('subtotal', { min: 0 }),
        number('tax_amount', { min: 0 }),
        number('total', { min: 0 }),
        select('status', ['draft', 'open', 'closed', 'void']),
        text('notes'),
    ], {
        indexes: [
            'CREATE UNIQUE INDEX idx_credit_note_number ON credit_notes (credit_note_number)',
        ],
    }),

    // ── 11. CREDIT NOTE ITEMS ────────────
    collection('credit_note_items', [
        relation('credit_note', 'pbc_credit_notes', { required: true, cascadeDelete: true }),
        relation('item', 'pbc_items', { required: true }),
        number('quantity', { min: 0, required: true }),
        number('rate', { min: 0, required: true }),
        number('cost_price', { min: 0 }),                   // purchase price snapshot
        relation('tax_rate', 'pbc_tax_rates'),
        number('tax_amount', { min: 0 }),
        number('amount', { min: 0, required: true }),
    ], { noSoftDelete: true }),

    // ── 12. BILLS ────────────────────────
    collection('bills', [
        orgField(),
        relation('vendor', 'pbc_vendors', { required: true }),
        text('bill_number', { max: 50, required: true, presentable: true }),
        date('bill_date', { required: true }),
        date('due_date'),
        text('payment_terms', { max: 50 }),
        number('subtotal', { min: 0 }),
        number('tax_amount', { min: 0 }),
        number('discount'),
        number('round_off'),
        json('extra_charges'),
        number('total', { min: 0 }),
        select('status', ['draft', 'open', 'paid', 'partial', 'overdue', 'void'], { required: true }),
        number('amount_paid', { min: 0 }),
        number('amount_due'),
        text('notes'),
    ], {
        indexes: [
            'CREATE UNIQUE INDEX idx_bill_number ON bills (bill_number)',
        ],
    }),

    // ── 13. BILL ITEMS ───────────────────
    collection('bill_items', [
        relation('bill', 'pbc_bills', { required: true, cascadeDelete: true }),
        relation('item', 'pbc_items', { required: true }),
        number('quantity', { min: 0, required: true }),
        number('rate', { min: 0, required: true }),
        relation('tax_rate', 'pbc_tax_rates'),
        number('tax_amount', { min: 0 }),
        number('amount', { min: 0, required: true }),
    ], { noSoftDelete: true }),

    // ── 14. PAYMENTS MADE ────────────────
    collection('payments_made', [
        orgField(),
        text('payment_number', { max: 50, required: true, presentable: true }),
        relation('vendor', 'pbc_vendors', { required: true }),
        relation('bill', 'pbc_bills'),
        number('amount', { min: 0, required: true }),
        date('payment_date', { required: true }),
        select('payment_mode', ['cash', 'cheque', 'bank_transfer', 'upi', 'card'], { required: true }),
        text('paid_through', { max: 100 }),
        text('reference_number', { max: 100 }),
        text('notes'),
    ]),

    // ── 15. VENDOR CREDITS ───────────────
    collection('vendor_credits', [
        orgField(),
        relation('vendor', 'pbc_vendors', { required: true }),
        text('credit_number', { max: 50, required: true, presentable: true }),
        date('credit_date', { required: true }),
        relation('bill', 'pbc_bills'),
        number('subtotal', { min: 0 }),
        number('tax_amount', { min: 0 }),
        number('total', { min: 0 }),
        select('status', ['draft', 'open', 'closed', 'void']),
        text('notes'),
    ], {
        indexes: [
            'CREATE UNIQUE INDEX idx_vendor_credit_number ON vendor_credits (credit_number)',
        ],
    }),

    // ── 16. VENDOR CREDIT ITEMS ──────────
    collection('vendor_credit_items', [
        relation('vendor_credit', 'pbc_vendor_credits', { required: true, cascadeDelete: true }),
        relation('item', 'pbc_items', { required: true }),
        number('quantity', { min: 0, required: true }),
        number('rate', { min: 0, required: true }),
        relation('tax_rate', 'pbc_tax_rates'),
        number('tax_amount', { min: 0 }),
        number('amount', { min: 0, required: true }),
    ], { noSoftDelete: true }),

    // ── 17. INVENTORY ADJUSTMENTS ────────
    collection('inventory_adjustments', [
        orgField(),
        select('adjustment_type', ['quantity', 'value'], { required: true }),
        date('adjustment_date', { required: true }),
        text('reference_number', { max: 50 }),
        text('reason', { required: true }),
        text('notes'),
        select('status', ['draft', 'adjusted']),
    ]),

    // ── 18. INVENTORY ADJUSTMENT ITEMS ───
    collection('inventory_adjustment_items', [
        relation('adjustment', 'pbc_inventory_adjustments', { required: true, cascadeDelete: true }),
        relation('item', 'pbc_items', { required: true }),
        number('quantity_adjusted', { required: true }), // positive = increase, negative = decrease
        number('value'),
    ], { noSoftDelete: true }),

    // ── 19. SALES RETURNS ───────────────
    collection('sales_returns', [
        orgField(),
        text('return_number', { max: 50, required: true, presentable: true }),
        relation('customer', 'pbc_customers', { required: true }),
        relation('invoice', 'pbc_invoices'),
        date('return_date', { required: true }),
        text('reason', { required: true }),
        number('subtotal', { min: 0 }),
        number('tax_amount', { min: 0 }),
        number('total', { min: 0 }),
        select('status', ['draft', 'confirmed', 'void'], { required: true }),
        text('notes'),
    ]),

    // ── 20. SALES RETURN ITEMS ──────────
    collection('sales_return_items', [
        relation('sales_return', 'pbc_sales_returns', { required: true, cascadeDelete: true }),
        relation('item', 'pbc_items', { required: true }),
        number('quantity', { min: 0, required: true }),
        number('rate', { min: 0, required: true }),
        number('cost_price', { min: 0 }),                   // purchase price snapshot
        relation('tax_rate', 'pbc_tax_rates'),
        number('tax_amount', { min: 0 }),
        number('amount', { min: 0, required: true }),
    ], { noSoftDelete: true }),

    // ── 21. PURCHASE RETURNS ────────────
    collection('purchase_returns', [
        orgField(),
        text('return_number', { max: 50, required: true, presentable: true }),
        relation('vendor', 'pbc_vendors', { required: true }),
        relation('bill', 'pbc_bills'),
        date('return_date', { required: true }),
        text('reason', { required: true }),
        number('subtotal', { min: 0 }),
        number('tax_amount', { min: 0 }),
        number('total', { min: 0 }),
        select('status', ['draft', 'confirmed', 'void'], { required: true }),
        text('notes'),
    ]),

    // ── 22. PURCHASE RETURN ITEMS ───────
    collection('purchase_return_items', [
        relation('purchase_return', 'pbc_purchase_returns', { required: true, cascadeDelete: true }),
        relation('item', 'pbc_items', { required: true }),
        number('quantity', { min: 0, required: true }),
        number('rate', { min: 0, required: true }),
        relation('tax_rate', 'pbc_tax_rates'),
        number('tax_amount', { min: 0 }),
        number('amount', { min: 0, required: true }),
    ], { noSoftDelete: true }),

    // ── 23. ITEM CONVERSIONS / PACKING ORDERS ────────────
    collection('item_conversions', [
        orgField(),
        text('conversion_number', { max: 50, required: true, presentable: true }),
        date('conversion_date', { required: true }),
        
        // What you are consuming (e.g. 100kg Bag)
        relation('source_item', 'pbc_items', { required: true }),
        number('source_quantity', { min: 0, required: true }), 
        
        // What you are packing it into (e.g. 1kg Packet)
        relation('target_item', 'pbc_items', { required: true }),
        number('target_quantity', { min: 0, required: true }), 
        
        number('conversion_cost', { min: 0 }), // Optional: cost of the plastic bags, labor, etc.
        text('notes'),
    ], {
        indexes: [
            'CREATE UNIQUE INDEX idx_conversion_number ON item_conversions (conversion_number)',
        ],
    }),

    // ── 24. PARTNER INVESTMENTS ──────────
    collection('partner_investments', [
        orgField(),
        relation('partner', 'pbc_partners', { required: true, cascadeDelete: true }),
        number('amount', { min: 0, required: true }),
        date('investment_date', { required: true }),
        select('payment_mode', ['cash', 'cheque', 'bank_transfer', 'upi', 'card']),
        text('reference_number', { max: 100 }),
        text('notes'),
    ]),

    // ── 25. PARTNER COMMITMENTS ─────────
    collection('partner_commitments', [
        orgField(),
        relation('partner', 'pbc_partners', { required: true, cascadeDelete: true }),
        number('committed_amount', { min: 0, required: true }),
        date('commitment_date', { required: true }),
        date('due_date'),
        text('notes'),
        bool('is_fulfilled'),
    ]),

    // ── 26. STOREFRONT CUSTOMERS ────────
    collection('storefront_customers', [
        orgField(),
        relation('user', '_pb_users_auth_'),
        text('phone', { max: 20, required: true, presentable: true }),
        text('name', { max: 200 }),
        email('email'),
        text('otp_code', { max: 10 }),
        date('otp_expires_at'),
        bool('is_verified'),
    ], {
        indexes: [
            'CREATE UNIQUE INDEX idx_storefront_customers_phone ON storefront_customers (phone)',
        ],
    }),

    // ── 27. CUSTOMER ADDRESSES ──────────
    collection('customer_addresses', [
        relation('customer', 'pbc_storefront_customers', { required: true, cascadeDelete: true }),
        text('label', { max: 50 }),
        text('full_name', { max: 200 }),
        text('phone', { max: 20 }),
        text('address_line1', { required: true }),
        text('address_line2'),
        text('city', { required: true }),
        text('state', { required: true }),
        text('postal_code', { max: 20, required: true }),
        text('country', { max: 100 }),
        bool('is_default'),
    ]),

    // ── 28. STOREFRONT ORDERS ───────────
    collection('storefront_orders', [
        orgField(),
        relation('customer', 'pbc_storefront_customers', { required: true }),
        relation('invoice', 'pbc_invoices'),
        relation('customer_address', 'pbc_customer_addresses'),
        text('order_number', { max: 50, required: true, presentable: true }),
        select('status', [
            'browsing', 'cart', 'payment_pending', 'confirmed',
            'processing', 'shipped', 'delivered', 'cancelled',
            'return_requested', 'return_approved', 'returned',
        ], { required: true }),
        number('subtotal', { min: 0 }),
        number('tax_amount', { min: 0 }),
        number('shipping_charge', { min: 0 }),
        number('discount', { min: 0 }),
        number('total', { min: 0 }),
        number('amount_paid', { min: 0 }),
        select('payment_method', ['cashfree', 'cod']),
        text('payment_order_id', { max: 100 }),
        text('payment_session_id', { max: 500 }),
        select('payment_status', ['pending', 'paid', 'failed', 'refunded']),
        text('customer_notes'),
        json('cart_snapshot'),
    ], {
        indexes: [
            'CREATE UNIQUE INDEX idx_storefront_order_number ON storefront_orders (order_number)',
        ],
    }),

    // ── 29. ORDER ITEMS ─────────────────
    collection('order_items', [
        relation('order', 'pbc_storefront_orders', { required: true, cascadeDelete: true }),
        relation('item', 'pbc_items', { required: true }),
        text('item_name', { max: 200 }),
        text('variant_label', { max: 100 }),
        number('quantity', { min: 0, required: true }),
        number('selling_price', { min: 0, required: true }),
        number('mrp', { min: 0 }),
        number('weight', { min: 0 }),
        text('weight_unit', { max: 10 }),
        text('unit', { max: 10 }),
        number('total', { min: 0, required: true }),
    ], { noSoftDelete: true }),

    // ── 30. ORDER TRACKING ──────────────
    collection('order_tracking', [
        relation('order', 'pbc_storefront_orders', { required: true, cascadeDelete: true }),
        select('status', [
            'payment_pending', 'confirmed', 'processing',
            'shipped', 'delivered', 'cancelled',
            'return_requested', 'return_approved', 'returned',
        ], { required: true }),
        text('note'),
        bool('is_admin_note'),
    ]),

    // ── 31. CUSTOMER WISHLIST ───────────
    collection('customer_wishlist', [
        relation('customer', 'pbc_storefront_customers', { required: true }),
        relation('item', 'pbc_items', { required: true }),
    ], {
        indexes: [
            'CREATE UNIQUE INDEX idx_wishlist_customer_item ON customer_wishlist (customer, item)',
        ],
    }),

    // ── 32. RETURN REQUESTS ─────────────
    collection('return_requests', [
        orgField(),
        relation('order', 'pbc_storefront_orders', { required: true }),
        relation('customer', 'pbc_storefront_customers', { required: true }),
        relation('order_item', 'pbc_order_items'),
        number('quantity', { min: 1 }),
        text('reason', { required: true }),
        text('description'),
        select('status', ['pending', 'approved', 'rejected', 'completed'], { required: true }),
        text('admin_note'),
    ]),

];

// ========================================
//           IMPORT SCRIPT
// ========================================

const PB_URL = process.env.PB_PUBLIC_URL;
const ADMIN_EMAIL = process.env.PB_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.PB_ADMIN_PASSWORD;

function stripRelations(col) {
    const relationFieldNames = col.fields.filter(f => f.type === 'relation').map(f => f.name);
    return {
        ...col,
        fields: col.fields.filter(f => f.type !== 'relation'),
        indexes: col.indexes.filter(idx => !relationFieldNames.some(rn => idx.includes(rn))),
    };
}

async function importCollections() {
    const pb = new PocketBase(PB_URL);

    try {
        console.log('[AUTH] Authenticating...');
        await pb.collection('_superusers').authWithPassword(ADMIN_EMAIL, ADMIN_PASSWORD);
        console.log(`[OK] Importing ${schema.length} collections\n`);

        // PASS 1: Create/update WITHOUT relations
        console.log('--- PASS 1: Creating collections (without relations) ---\n');
        for (const col of schema) {
            try {
                const existing = await pb.collections.getList(1, 1, { filter: `name = "${col.name}"` });
                const stripped = stripRelations(col);

                if (existing.totalItems > 0) {
                    const existingCol = await pb.collections.getFirstListItem(`name = "${col.name}"`);
                    
                    // Merge fields by name to preserve IDs and avoid data deletion
                    // IMPORTANT: In PASS 1, we must intentionally keep EXISTING relation fields, 
                    // otherwise PocketBase drops their columns (and data) before PASS 2 can re-add them.
                    const existingRelationFields = (existingCol.fields || []).filter(f => f.type === 'relation');
                    
                    const nonRelFieldsMerged = stripped.fields.map(nf => {
                        const ef = (existingCol.fields || []).find(f => f.name === nf.name);
                        return ef ? { ...nf, id: ef.id } : nf;
                    });
                    
                    // Combine non-rel fields defined in schema + existing rel fields.
                    // This way we only add new non-rel fields without dropping existing rel fields.
                    const pass1Fields = [...existingRelationFields, ...nonRelFieldsMerged];

                    if (col.type === 'auth') {
                        const authFieldsMerged = [
                            ...(existingCol.fields || []).filter(ef => ef.system || !pass1Fields.some(mf => mf.name === ef.name)),
                            ...pass1Fields
                        ];
                        await pb.collections.update(existingCol.id, { ...stripped, fields: authFieldsMerged });
                    } else {
                        await pb.collections.update(existingCol.id, { ...stripped, fields: pass1Fields });
                    }
                    console.log(`[UPDATE] ${col.name}`);
                } else {
                    await pb.collections.create(stripped);
                    console.log(`[CREATE] ${col.name}`);
                }
            } catch (error) {
                console.error(`[ERROR] ${col.name}:`, error.response?.data || error.message);
            }
        }

        // PASS 2: Add relations
        console.log('\n--- PASS 2: Adding relations ---\n');
        for (const col of schema) {
            try {
                const existingCol = await pb.collections.getFirstListItem(`name = "${col.name}"`);
                
                const mergedFields = col.fields.map(nf => {
                    const ef = (existingCol.fields || []).find(f => f.name === nf.name);
                    return ef ? { ...nf, id: ef.id } : nf;
                });

                if (col.type === 'auth') {
                    const authFieldsMerged = [
                        ...(existingCol.fields || []).filter(ef => !mergedFields.some(mf => mf.name === ef.name)),
                        ...mergedFields
                    ];
                    await pb.collections.update(existingCol.id, { fields: authFieldsMerged });
                } else {
                    await pb.collections.update(existingCol.id, { fields: mergedFields });
                }
                console.log(`[RELATIONS] ${col.name}`);
            } catch (error) {
                console.error(`[ERROR] ${col.name}:`, error.response?.data || error.message);
            }
        }

        // PASS 3: Seed default tax rates and currencies
        console.log('\n--- PASS 3: Seeding default tax rates & currencies ---\n');

        // --- TAX SEEDING ---
        const defaultTaxes = [
            { name: 'GST0', rate: 0, description: 'Exempt / Nil rated' },
            { name: 'GST5', rate: 5, description: 'GST at 5%' },
            { name: 'GST12', rate: 12, description: 'GST at 12%' },
            { name: 'GST18', rate: 18, description: 'GST at 18%' },
            { name: 'GST28', rate: 28, description: 'GST at 28%' },
        ];

        const existingTaxes = await pb.collection('tax_rates').getList(1, 1);
        if (existingTaxes.totalItems === 0) {
            console.log('[INFO] Seeding default tax rates...');
            for (const tax of defaultTaxes) await pb.collection('tax_rates').create(tax);
        } else {
            console.log(`[SKIP] ${existingTaxes.totalItems} tax rates already exist.`);
        }

        // --- CURRENCY SEEDING ---
        const defaultCurrencies = [
            { code: 'INR', symbol: '₹', name: 'Indian Rupee' },
            { code: 'USD', symbol: '$', name: 'US Dollar' },
            { code: 'EUR', symbol: '€', name: 'Euro' },
            { code: 'GBP', symbol: '£', name: 'British Pound' },
        ];

        const existingCurrencies = await pb.collection('currencies').getList(1, 1);
        if (existingCurrencies.totalItems === 0) {
            console.log('[INFO] Seeding default currencies...');
            for (const currency of defaultCurrencies) await pb.collection('currencies').create(currency);
        } else {
            console.log(`[SKIP] ${existingCurrencies.totalItems} currencies already exist.`);
        }

        console.log('\n[DONE] All collections imported successfully!');
    } catch (error) {
        console.error('[AUTH ERROR]', error.message);
        if (error.response && error.response.data) {
            console.error('[API DETAILS]', JSON.stringify(error.response.data, null, 2));
        }
    }
}

importCollections();
