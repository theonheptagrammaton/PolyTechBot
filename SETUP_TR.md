# 🚀 Polymarket Telegram Bot - Kurulum Rehberi

## ✅ Tamamlanan Adımlar

1. ✅ Proje yapısı oluşturuldu
2. ✅ Tüm bağımlılıklar yüklendi
3. ✅ PostgreSQL ve Redis başlatıldı (Docker)
4. ✅ Veritabanı migration'ları tamamlandı
5. ✅ Encryption key otomatik oluşturuldu

## 📋 Şimdi Yapmanız Gerekenler

### 1. Telegram Bot Token Alın

1. Telegram'da [@BotFather](https://t.me/botfather) botunu açın
2. `/newbot` komutunu gönderin
3. Bot için bir isim girin (örnek: "My Polymarket Bot")
4. Bot için bir kullanıcı adı girin (örnek: "my_polymarket_bot")
5. BotFather size bir token verecek (örnek: `1234567890:ABCdefGHIjklMNOpqrsTUVwxyz`)

### 2. Bot Token'ı .env Dosyasına Ekleyin

`.env` dosyasını açın ve bot token'ınızı ekleyin:

```bash
TELEGRAM_BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrsTUVwxyz
```

### 3. Telegram User ID'nizi Öğrenin

Admin olmak için Telegram user ID'nize ihtiyacınız var:

**Yöntem 1:** [@userinfobot](https://t.me/userinfobot) botunu kullanın
- Bota `/start` gönderin
- Size ID'nizi verecek (örnek: `123456789`)

**Yöntem 2:** [@raw_data_bot](https://t.me/raw_data_bot) botunu kullanın
- Bota mesaj gönderin
- `"from"` > `"id"` alanına bakın

### 4. Admin ID'nizi .env Dosyasına Ekleyin

```bash
ADMIN_USER_IDS=123456789
```

Birden fazla admin eklemek için virgülle ayırın:
```bash
ADMIN_USER_IDS=123456789,987654321
```

### 5. Botu Başlatın

Development modunda (otomatik yeniden başlatma):
```bash
npm run dev
```

Production modunda:
```bash
npm run build
npm start
```

## 🎉 Bot Hazır!

Telegram'da botunuzu bulun ve `/start` komutunu gönderin!

## 📱 Kullanılabilir Komutlar

### Kullanıcı Komutları
- `/start` - Polymarket cüzdanınızı oluşturun
- `/help` - Yardım mesajını göster
- `/wallet` - Cüzdan bilgilerinizi göster

### Admin Komutları
- `/stats` - Bot istatistiklerini göster
- `/users` - Tüm kullanıcıları listele

## 🔒 Güvenlik Notları

1. **Private Key Güvenliği**: Bot kullanıcılara private key'lerini sadece ONCE gösterir (wallet oluşturulduğunda)
2. **Encryption**: Tüm hassas veriler AES-256-GCM ile şifrelenir
3. **Veritabanı**: Private key'ler ve API credential'lar şifreli olarak PostgreSQL'de saklanır
4. **Cache**: Redis yalnızca şifreli verileri cache'ler

## 🛠️ Sorun Giderme

### Bot başlamıyor

1. Docker servislerini kontrol edin:
```bash
docker-compose ps
```

2. Log'ları kontrol edin:
```bash
docker-compose logs postgres
docker-compose logs redis
```

3. .env dosyasını kontrol edin:
```bash
cat .env
```

### Veritabanı bağlantı hatası

```bash
# Servisleri yeniden başlatın
docker-compose restart postgres

# Bağlantıyı test edin
docker exec polytech-postgres pg_isready -U polytech
```

### Redis bağlantı hatası

```bash
# Redis'i yeniden başlatın
docker-compose restart redis

# Bağlantıyı test edin
docker exec polytech-redis redis-cli ping
```

## 📊 Veritabanı Yönetimi

### Prisma Studio ile veritabanını görüntüle

```bash
npm run db:studio
```

Tarayıcınızda http://localhost:5555 açılacak.

### Migration oluştur

```bash
npx prisma migrate dev --name migration_ismi
```

### Veritabanını sıfırla

```bash
npx prisma migrate reset
```

## 🐳 Docker Komutları

### Tüm servisleri başlat
```bash
docker-compose up -d
```

### Servisleri durdur
```bash
docker-compose down
```

### Log'ları görüntüle
```bash
docker-compose logs -f bot
docker-compose logs -f postgres
docker-compose logs -f redis
```

### Verileri sil ve yeniden başlat
```bash
docker-compose down -v
docker-compose up -d
npx prisma migrate dev
```

## 🌟 Özellikler

### Şu an Aktif
- ✅ Otomatik Polymarket wallet oluşturma
- ✅ Private key ve API credential'ları güvenli saklama
- ✅ Admin paneli (istatistikler ve kullanıcı listesi)
- ✅ Redis caching
- ✅ Kapsamlı loglama

### Gelecek Özellikler (Daha sonra eklenecek)
- ⏳ Wallet bakiyesi görüntüleme
- ⏳ Polymarket piyasalarını listeleme
- ⏳ Order (emir) verme
- ⏳ Açık emirleri görüntüleme
- ⏳ Emir iptali
- ⏳ İşlem geçmişi
- ⏳ Fiyat alarmları

## 💡 İpuçları

1. **Development**: `npm run dev` kullanın, kod değişikliklerinde otomatik yeniden başlar
2. **Production**: `npm run build && npm start` kullanın
3. **Logs**: `logs/` klasöründe saklanır
4. **Database**: Prisma Studio ile görsel olarak yönetin

## 📞 Destek

Sorun yaşarsanız:
1. Log dosyalarını kontrol edin (`logs/combined.log`)
2. Docker servislerinin durumunu kontrol edin
3. GitHub'da issue açın

## ⚠️ Önemli Hatırlatmalar

1. `.env` dosyasını asla paylaşmayın veya commit etmeyin
2. Private key'lerinizi güvenli tutun
3. Production'da güçlü şifreler kullanın
4. Düzenli olarak backup alın

## 🎯 Test Senaryosu

1. Botu başlatın: `npm run dev`
2. Telegram'da botunuzu bulun
3. `/start` komutunu gönderin
4. Wallet oluşturulmasını bekleyin
5. Private key'inizi güvenli bir yere kaydedin
6. `/wallet` ile wallet bilgilerinizi kontrol edin
7. `/help` ile mevcut komutları görün

Başarılar! 🚀
