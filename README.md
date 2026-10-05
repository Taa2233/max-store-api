# MAX STORE API على Render Free

## المتغيرات السرية في Render

أضف Environment Variables التالية من لوحة Render:

- `FIREBASE_SERVICE_ACCOUNT_JSON`: محتوى ملف Service Account JSON كاملًا في سطر واحد.
- `ALLOWED_ORIGIN`: رابط موقع المتجر النهائي، مثل `https://example.com`.
- `PORT`: لا تضفه عادة؛ Render يحقنه تلقائيًا.

لا ترفع `service-account.json` إلى GitHub أو Render كملف داخل المستودع. انسخ محتواه فقط إلى Secret Environment Variable.

## إعداد Render

- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm start`
- Health Check Path: `/health`

بعد النشر سيكون لديك رابط مثل:

```text
https://max-store-api.onrender.com
```

اختبره:

```text
https://max-store-api.onrender.com/health
```

ويجب أن يرجع:

```json
{"ok":true,"service":"max-store-api"}
```

## Endpoint

```text
POST /createOrder
Authorization: Bearer FIREBASE_ID_TOKEN
Content-Type: application/json
```

Body:

```json
{
  "items": [
    {"productId": "FIRESTORE_PRODUCT_ID", "quantity": 1}
  ],
  "couponCode": "MAX20"
}
```

السعر لا يؤخذ من الطلب؛ يتم قراءته من Firestore بواسطة Firebase Admin SDK.

## ملاحظات مهمة

- Render Free ينام بعد 15 دقيقة من عدم الاستخدام؛ أول طلب بعد النوم قد يتأخر.
- لا تحفظ الإيصالات على القرص المحلي؛ استخدم Firebase Storage.
- لا تضع Service Account JSON في Frontend.
- غيّر `ALLOWED_ORIGIN` من `*` إلى رابط موقعك عند الإطلاق.
