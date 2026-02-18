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