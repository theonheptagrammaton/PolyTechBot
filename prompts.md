❯ bir telegram botu yapmak istiyorum. adminler olacak, redis ve postgre sql veritabanı olacak. Botu kullanıcılar start yaptığında bot onlara özel bir polymarket wallet oluşturacak  
  ve bilgilerini vericek onlara, wallet adresi ve secret keyini, kullanıcılar botu açtığında ilk iş olarak anon bir polymarket wallet oluşacak onlara özel, sonrasında telegram      
  üzerinden işlemler yapıcaklar polymarkette, ama şuan tek istediğim kullanıcı botla sohbet oluşturduğunda ona özel bir polymarket wallet oluşturması.                               
  https://docs.polymarket.com/quickstart/overview bu sayfada polymarket dökümanları var, apiler vs her şey burada, kusursuz çalışmasını istiyorum bu özelliğin kalan her şeyi sonra  
  yapıcaz, şuan tek yapılacak şey botu başlatan kullanıcıya özel polymarket wallet oluşturulması, sonrasında sağlayacağız işlem yapmasını. production ready şekilde oluştur her      
  şeyi. Hata istemiyorum, hiç bir placeholder olmayacak, tamamen gerçek veri olacak.   
❯ mükemmel, şimdi buton ekle wallet oluşturulduktan sonra market butonu olsun, market butonuna tıklandığında polymarket kategorileri açılsın buton olarak, kategori butonlarına tıklandığında tıklanan         
  kategorideki en popüler veya en yüksek hacime sahip bahisler görünsün. Hiç bir placeholder istemiyorum, her şey gerçek veri olmalı, apiler https://docs.polymarket.com/quickstart/overview bu linkte       
  mevcut, her şey gerçek veri olmalı. Hata İstemiyorum, placeholder olmayacak tamamen gerçek veri olacak. Kusursuz çalışmalı, sonrasında kullanıcının oluşturduğumuz walletıyla bu marketlerde trade           
  yapmasını sağlayacağız. Ama şimdilik sadecece sadece söylediğim market, kategori butonları ve popüler veya yüksek hacimli marketleri hallet. Hata yapma. 
❯ şimdi wallet bölümünü geliştireceğiz. şuan halihazırda çalışan polymarket wallet oluşturma bozulmayacak, çalışan hiç bir şeyi eksiltmeden sadece ekleyerek yapacaksın. ana sayfadaki wallet butonu tam    
  olarak fotoğraftaki şekilde çalışmalı, bu walletları oluşturmalıyız her kullanıcıya özel.profile butonu polymarket walletına yönlendirmeli. Wallet sayfası tamamen gerçek ve çalışan şekilde hiç bir          
  placeholder veya eksik veri olmadan olacak şekilde bu sayfayı verebilmeli. Her şey gerçekten çalışmalı, tamamen production odaklı, yayınlamaya hazır şekilde olmalı. Hata yapma.fotoğraftaki diğer          
  kısımları sonra yapıcaz. şimdi sadece hiç bir şeyi bozmadan söylediklerimi ekle tamamen yayına almaya hazır olacak şekilde. Her şeyi test et hata istemiyorum. 

    Market arama özelliği ekle:
  - /search [keyword] komutu
  - Inline "🔍 Search Markets" butonu ekle (Browse Markets yanına)
  - Keyword ile market ara (question + events)
  - Sonuçları pagination ile göster
  - Minimum 3 karakter zorunluluğu
  - "No results" mesajı

    Wallet balance gösterimi ekle:
  - Polymarket CLOB API'den balance çek
  - getBalance() fonksiyonu ekle
  - Wallet sayfasında "$0.00" yerine gerçek balance
  - Error handling (API fail durumu)
  - Cache 1 dakika

📋 Trading & Deposit Özelliği İçin Sorular

  1️⃣  DEPOSIT (Bakiye Yükleme)

  Soru 1.1: Deposit nasıl çalışsın?
  - A) Kullanıcı Polygon/Ethereum/Solana'dan USDC gönderir → Bot otomatik algılar ve Polymarket'e transfer eder
  - B) Kullanıcıya sadece deposit adresi göster → Kullanıcı manuel gönderir → "Approve" butonu ile Polymarket'e aktarır
  - C) External wallet (MetaMask gibi) ile connect → Direkt Polymarket'e deposit

  Soru 1.2: Chain tercihi?
  - A) Sadece Polygon (Polymarket native chain, düşük fee)
  - B) Polygon + Ethereum (iki seçenek)
  - C) Polygon + Ethereum + Solana (üç seçenek)

  Soru 1.3: Minimum deposit limiti olsun mu?
  - A) Evet, minimum $10 (Polymarket minimum)
  - B) Evet, minimum $50 (daha güvenli)
  - C) Hayır, limit olmasın

  ---
  2️⃣  TRADING (İşlem Yapma)

  Soru 2.1: Hangi order tiplerini destekleyelim?
  - A) Sadece Market Order (anında al/sat, basit)
  - B) Market + Limit Order (fiyat belirle, bekle)
  - C) Market + Limit + Stop Loss (risk yönetimi ile)
  - D) Hepsi + Advanced (GTC, FOK, IOC gibi)

  Soru 2.2: Trade UI nasıl olsun?
  - A) Basit: Market seç → YES/NO seç → Miktar gir → Onayla
  - B) Detaylı: Market seç → Order tipi seç → Fiyat belirle → Miktar gir → Slippage ayarla → Onayla
  - C) Çok detaylı: + Risk calculator + P&L preview + Fee hesaplama + Position sizing

  Soru 2.3: Trade onayı nasıl olsun?
  - A) Direkt onay (tek tuş)
  - B) Özet göster + onayla (iki adım)
  - C) Özet + 2FA kodu + onayla (üç adım, çok güvenli)

  Soru 2.4: Market browsing'den direkte trade?
  - A) Evet, market detaylarında "🟢 BUY YES" / "🔴 SELL NO" butonları olsun
  - B) Hayır, sadece portfolio'dan veya özel trade menüsünden

  ---
  3️⃣  2FA (İki Faktörlü Doğrulama)

  Soru 3.1: 2FA ne zaman zorunlu olsun?
  - A) Her trade'de (çok güvenli ama zahmetli)
  - B) Sadece withdraw ve yüksek miktarda trade'lerde ($100+)
  - C) Sadece withdraw ve critical işlemlerde
  - D) İsteğe bağlı (kullanıcı aktifleştirirse kullanır)

  Soru 3.2: 2FA setup nasıl olsun?
  - A) QR kod göster → Google Authenticator ile tara → 6 haneli kodu doğrula
  - B) QR kod + backup codes ver (12 adet recovery code)
  - C) QR kod + backup codes + SMS alternatifi

  Soru 3.3: 2FA kaybedilirse?
  - A) Backup codes ile recovery
  - B) Support'a başvur (telegram ID ile doğrulama)
  - C) Otomatik 24 saat sonra reset (riskli ama pratik)

  ---
  4️⃣  RİSK YÖNETİMİ & GÜVENLİK

  Soru 4.1: Trade limitleri olsun mu?
  - A) Evet, günlük max $500 trade limiti
  - B) Evet, kullanıcı kendi limitini belirleyebilir
  - C) Hayır, limit olmasın

  Soru 4.2: Slippage protection?
  - A) Evet, otomatik %1 slippage (market order için)
  - B) Evet, kullanıcı ayarlayabilir (%0.5 - %5 arası)
  - C) Hayır gerekli değil

  Soru 4.3: Transaction confirmation?
  - A) Telegram'da notification (başarılı/başarısız)
  - B) Telegram notification + blockchain explorer linki
  - C) Sadece portfolio'da görünsün

  ---
  5️⃣  WITHDRAW (Para Çekme)

  Soru 5.1: Withdraw nasıl çalışsın?
  - A) Polymarket'ten USDC çek → Bot wallet'e al → Kullanıcının external adresine gönder
  - B) Polymarket'ten direkt kullanıcının adresine gönder
  - C) Manuel approval (her withdraw'da admin onayı)

  Soru 5.2: Withdraw fee?
  - A) Gas fee'yi kullanıcı öder (dinamik)
  - B) Sabit fee al ($1-2)
  - C) Fee yok, bot karşılar

  ---
  6️⃣  ÖNCELIK & IMPLEMENTATION

  Soru 6.1: Hangi sırayla implement edelim?
  - A) Önce Deposit → Sonra 2FA → Sonra Trading
  - B) Önce 2FA → Sonra Deposit → Sonra Trading
  - C) Hepsi birlikte (3-4 saat iş)

  Soru 6.2: Test ortamı?
  - A) Testnet'te test et (Mumbai/Amoy testnet)
  - B) Mainnet'te küçük miktarla test ($1-5)
  - C) Direkt mainnet production

  ---
  📝 Cevaplama Formatı

  Lütfen her soruya harf ile cevap ver, örnek:

  1.1: B
  1.2: A
  1.3: A
  2.1: B
  2.2: B
  ...


  Ya da her soruyu tek tek açıklayabilirsin. Ben cevaplarına göre:
  1. Detaylı implementation planı hazırlayacağım
  2. Gerekli API endpoints belirleyeceğim
  3. Step-by-step prompt oluşturacağım veya direkt kodu yazacağım

  Hazır mısın? 🚀

✻ Baked for 47s

❯ 1.1: c                                                                                                                                                                                                    
    1.2: c                                                                                                                                                                                                  
    1.3: a                                                                                                                                                                                                  
                                                                                                                                                                                                                
    2.1: b                                                                                                                                                                                                  
    2.2: b                                                                                                                                                                                                      
    2.3: b                                                                                                                                                                                                    
    2.4: a                                                                                                                                                                                                  
                                                                                                                                                                                                            
    3.1: b                                                                                                                                                                                                  
    3.2: a                                                                                                                                                                                                  
    3.3: a                                                                                                                                                                                                  
                                                                                                                                                                                                            
    4.1: c                                                                                                                                                                                                  
    4.2: b                                                                                                                                                                                                  
    4.3: b                                                                                                                                                                                                  
                                                                                                                                                                                                            
    5.1: a                                                                                                                                                                                                  
    5.2: a                                                                                                                                                                                                  
                                                                                                                                                                                                            
    6.1: b                                                                                                                                                                                                  
    6.2: c                                                                                                                                                                                                  
                                                                                                                                                                                                            
    VE EN ÖNEMLİ KISIM: KULLANICILARIN YAPTIĞI HER ALIM VE SATIMDAN %1 (yani toplamda %2) ADMİNİN WALLETINA AKTARILACAK. KOMİSYON ALINACAK. VE BU KULLANICIYA BELİRTİLECEK. EN ÖNEMLİ KISIM BU. HATA        
  İSTEMİYORUM KUSURSUZ OLMALI. TAMAMEN PRODUCTİONA HAZIR ŞEKİLDE YAPILMALI HER ŞEY.         

    Favorites sistemi ekle:
  - Database'e Favorite model ekle (userId, marketId)
  - Market detayında "⭐ Favorite" toggle butonu
  - Ana menüde "⭐ My Favorites" butonu
  - Favorites sayfası: favori marketleri listele
  - "No favorites yet" empty state

  Recent markets tracking ekle:
  - Redis'e user:{id}:recent_markets list
  - Market görüntülendiğinde LPUSH
  - LTRIM 10 (max 10 market)
  - Ana menüde "🕐 Recent Markets" butonu
  - Recent sayfası: son 10 marketi göster
  - "No recent activity" empty state

