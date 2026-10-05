const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');

const app = express();
const PORT = Number(process.env.PORT || 10000);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_JSON environment variable');
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
} catch (error) {
  throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON');
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

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

async function requireUser(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return fail(res, 401, 'يلزم تسجيل الدخول.');
  }

  const idToken = header.slice('Bearer '.length).trim();
  try {
    req.user = await admin.auth().verifyIdToken(idToken);
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

    await orderRef.set({
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
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

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
