const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const app = express();
const PORT = Number(process.env.PORT || 10000);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';

if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_JSON environment variable');
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
} catch (error) {
  throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON');
}

initializeApp({
  credential: cert(serviceAccount),
});

const auth = getAuth();
const db = getFirestore();

app.use(helmet());
app.use(cors({
  origin: ALLOWED_ORIGIN === '*' ? true : ALLOWED_ORIGIN.split(',').map(v => v.trim()),
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '100kb' }));

const orderLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'محاولات كثيرة، حاول لاحقًا.' },
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'max-store-api' });
});

function fail(res, status, message) {
  return res.status(status).json({ error: message });
}

async function notifyDiscord(order) {
  if (!DISCORD_WEBHOOK_URL) {
    console.warn('DISCORD_WEBHOOK_URL is not configured; skipping notification.');
    return;
  }

  const itemLines = order.items
    .map(item => `• ${item.title} × ${item.quantity} — ${item.lineTotal.toFixed(2)} ر.س`)
    .join('\n');

  const payload = {
    username: 'MAX STORE',
    embeds: [{
      title: 'طلب جديد',
      color: 0x2ecc71,
      fields: [
        { name: 'رقم الطلب', value: order.orderId, inline: true },
        { name: 'الإجمالي', value: `${order.total.toFixed(2)} ر.س`, inline: true },
        { name: 'العميل', value: order.customerName || 'مستخدم', inline: true },
        { name: 'المنتجات', value: itemLines.slice(0, 1024) || '—' },
      ],
      timestamp: new Date().toISOString(),
    }],
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Discord returned HTTP ${response.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function requireUser(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return fail(res, 401, 'يلزم تسجيل الدخول.');
  }

  const idToken = header.slice('Bearer '.length).trim();
  try {
    req.user = await auth.verifyIdToken(idToken);
    next();
  } catch (error) {
    console.error('Token verification failed:', error.message);
    return fail(res, 401, 'جلسة الدخول غير صالحة أو منتهية.');
  }
}

app.post('/createOrder', orderLimiter, requireUser, async (req, res) => {
  try {
    const data = req.body || {};
    const rawItems = Array.isArray(data.items) ? data.items : [];
    const couponCode = typeof data.couponCode === 'string'
      ? data.couponCode.trim().toUpperCase()
      : null;

    if (rawItems.length === 0 || rawItems.length > 50) {
      return fail(res, 400, 'السلة فارغة أو تحتوي على عدد كبير من المنتجات.');
    }

    const quantities = new Map();
    for (const item of rawItems) {
      const productId = String(item.productId || '').trim();
      const quantity = Number(item.quantity);

      if (!productId) return fail(res, 400, 'معرف المنتج غير صالح.');
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
        return fail(res, 400, 'كمية المنتج غير صالحة.');
      }

      quantities.set(productId, (quantities.get(productId) || 0) + quantity);
    }

    const productIds = [...quantities.keys()];
    const productRefs = productIds.map(id => db.collection('products').doc(id));
    const productSnapshots = await db.getAll(...productRefs);

    const calculatedItems = [];
    let subtotal = 0;

    for (const snapshot of productSnapshots) {
      if (!snapshot.exists) return fail(res, 404, 'أحد المنتجات لم يعد موجودًا.');

      const product = snapshot.data();
      if (product.active === false) return fail(res, 409, 'أحد المنتجات غير متاح حاليًا.');

      const price = Number(product.price);
      const quantity = quantities.get(snapshot.id);
      if (!Number.isFinite(price) || price < 0) {
        return fail(res, 500, 'يوجد منتج بسعر غير صالح.');
      }

      const lineTotal = price * quantity;
      subtotal += lineTotal;
      calculatedItems.push({
        productId: snapshot.id,
        title: String(product.title || product.name || 'منتج'),
        unitPrice: price,
        quantity,
        lineTotal: Number(lineTotal.toFixed(2)),
      });
    }

    let discountPercent = 0;
    let discountAmount = 0;
    let couponId = null;

    if (couponCode) {
      const couponQuery = await db.collection('coupons')
        .where('code', '==', couponCode)
        .limit(1)
        .get();

      if (couponQuery.empty) return fail(res, 400, 'كود الخصم غير صحيح.');

      const couponDoc = couponQuery.docs[0];
      const coupon = couponDoc.data();
      const discount = Number(coupon.discount);

      if (!Number.isFinite(discount) || discount <= 0 || discount > 100) {
        return fail(res, 500, 'قيمة الخصم غير صالحة.');
      }
      if (coupon.active === false) return fail(res, 409, 'كود الخصم غير فعال.');

      if (coupon.expiresAt) {
        const expiry = coupon.expiresAt.toDate
          ? coupon.expiresAt.toDate()
          : new Date(coupon.expiresAt);
        if (expiry <= new Date()) return fail(res, 400, 'انتهت صلاحية كود الخصم.');
      }

      discountPercent = discount;
      discountAmount = Number(((subtotal * discountPercent) / 100).toFixed(2));
      couponId = couponDoc.id;
    }

    const cleanSubtotal = Number(subtotal.toFixed(2));
    const total = Number(Math.max(0, cleanSubtotal - discountAmount).toFixed(2));
    const orderRef = db.collection('orders').doc();

    const order = {
      orderId: orderRef.id,
      userId: req.user.uid,
      customerName: req.user.name || 'مستخدم',
      customerEmail: req.user.email || null,
      items: calculatedItems,
      subtotal: cleanSubtotal,
      discountPercent,
      discountAmount,
      total,
      couponId,
      couponCode: couponCode || null,
      status: 'pending_review',
      paymentMethod: 'bank_transfer',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };

    await orderRef.set({
      ...order,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    try {
      await notifyDiscord(order);
    } catch (discordError) {
      console.error('Discord notification failed:', discordError.message);
    }

    res.status(201).json({
      success: true,
      orderId: orderRef.id,
      subtotal: cleanSubtotal,
      discountPercent,
      discountAmount,
      total,
      status: 'pending_review',
    });
  } catch (error) {
    console.error('createOrder failed:', error);
    return fail(res, 500, 'تعذر إنشاء الطلب حاليًا.');
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`MAX STORE API listening on port ${PORT}`);
});
