# नेपाल कानून — वेब इन्टरफेस

नेपाल कानून आयोग (lawcommission.gov.np) बाट प्रकाशित ऐनहरूको खोज तथा पाठ हेर्नको लागि वेब इन्टरफेस।

## चलाउने तरिका

निश्चित गर्नुहोस् कि तपाईंले पहिला `npm install` गरिसक्नुभएको छ।

```bash
# वेब सर्भर चलाउनुहोस् (पोर्ट 3001)
npm run web

# ब्राउजरमा जानुहोस्
# http://localhost:3001
```

## API एन्डपोइन्टहरू

| एन्डपोइन्ट | विवरण |
|---|---|
| `GET /api/search?q=श्रम` | दफा र ऐन शीर्षकमा खोज गर्नुहोस् |
| `GET /api/acts` | सबै ऐनहरूको सूची |
| `GET /api/acts/:id` | दफा सहितको ऐन विवरण |
| `GET /api/acts/:id/provisions/:section` | एकल दफाको पाठ |
| `GET /api/stats` | डाटाबेस तथ्याङ्क |

## बनाउने तरिका (प्रोडक्सन)

```bash
# TypeScript कम्पाइल गर्नुहोस्
npm run build

# कम्पाइल गरिएको JS बाट चलाउनुहोस्
node dist/web/server.js
```

## डिप्लोइ (Deployment)

### PM2 (recommended)

```bash
npm run build
pm2 start dist/web/server.js --name nepal-law-web
```

### Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build
EXPOSE 3001
CMD ["node", "dist/web/server.js"]
```

## खोज एल्गोरिदम

बहु-शब्द खोज (जस्तै "सहकारी संस्था") को लागि:

1. **FTS5 AND प्रिफिक्स खोज** — `"सहकारी"* AND "संस्था"*` — दुवै शब्द FTS5 इन्डेक्समा मिल्नुपर्छ
2. **LIKE शब्द-स्तर AND फलब्याक** — प्रत्येक शब्दलाई अलग-अलग `LIKE '%शब्द%'` मिलाउँछ। प्रत्येक शब्दको लागि अलग `EXISTS` उपप्रश्न, त्यसैले "सहकारी संस्था" ले "सहकारीसंस्था" (एकै शब्द) पनि भेट्टाउँछ

## फाइल संरचना

```
web/
  server.ts         — Express.js REST API सर्भर
  public/
    index.html      — नेपाली भाषाको एकल-पृष्ठ अनुप्रयोग
  README.md         — यो फाइल
```
