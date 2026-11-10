# Paketleme: Masaüstü, Android ve iPad

Ozmix Studyo, **Tauri 2** ile yerel uygulama olarak paketlenir. DAW'ın tamamı `dist/index.html` içinde çalışır; Tauri onu her platformun kendi web motoruyla (macOS/iPadOS: WebKit, Windows: WebView2, Android: Chromium WebView, Linux: WebKitGTK) bir uygulama penceresine koyar ve kaydetme diyaloglarını ekler.

| Platform | Çıktı | Nerede derlenir |
|---|---|---|
| macOS (Apple Silicon + Intel) | `.dmg` | macOS |
| Windows 10/11 | `.msi` ve kurulum `.exe` | Windows |
| Linux | `.AppImage`, `.deb` | Linux |
| Android tablet / telefon (Android 8+) | `.apk` (yan yükleme), `.aab` (Google Play) | Linux / macOS / Windows |
| iPad / iPhone (iPadOS 15+) | `.ipa` (TestFlight / App Store) | **yalnızca macOS + Xcode** |

## 1. En kolay yol: GitHub Actions (bilgisayara hiçbir şey kurmadan)

1. Bu klasörü bir GitHub deposuna yükleyin.
2. **Actions › Build apps › Run workflow** deyin. Yaklaşık 20–30 dakikada masaüstü ve Android dosyaları hazır olur; çalıştırmanın sayfasındaki **Artifacts** bölümünden indirirsiniz.
3. `v0.9.0` gibi bir etiket (tag) gönderirseniz masaüstü dosyaları ayrıca taslak bir **Release**'e eklenir.

**Android:** Anahtar (keystore) tanımlamazsanız APK depodaki sabit test anahtarıyla (scripts/test-signing.keystore) imzalanır; kendi cihazlarınıza kurmak ve güncellemeleri üstüne kurmak için yeterlidir (Ayarlar › “Bilinmeyen kaynaklardan yükleme” izni). Google Play için kalıcı bir anahtar oluşturun ve depoya şu **secrets**'ları ekleyin:

```bash
keytool -genkey -v -keystore ozmix-studyo.keystore -alias upload -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 ozmix-studyo.keystore   # çıktıyı ANDROID_KEYSTORE_BASE64 olarak kaydedin
```

`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (= `upload`). Bu anahtar dosyasını kaybetmeyin: güncellemeler aynı anahtarla imzalanmalıdır.

**iPad / iOS:** Apple Developer Program üyeliği (yıllık ücretli) gerekir. Depoda **Settings › Variables**'a `IOS_ENABLED = true` ekleyin ve şu secrets'ları girin:

| Secret | İçerik |
|---|---|
| `APPLE_TEAM_ID` | Developer hesabınızdaki 10 karakterlik Team ID |
| `IOS_CERTIFICATE` | “Apple Distribution” sertifikasının `.p12` dosyası, base64 |
| `IOS_CERTIFICATE_PASSWORD` | `.p12` parolası |
| `IOS_MOBILE_PROVISION` | `com.ozmix.studyo` için App Store provisioning profile, base64 |
| `APP_STORE_API_KEY_ID`, `APP_STORE_API_ISSUER`, `APP_STORE_API_KEY` | (isteğe bağlı) App Store Connect API anahtarı: verilirse IPA otomatik TestFlight'a yüklenir |

**macOS imzalama (isteğe bağlı):** İmzasız `.dmg` çalışır ama ilk açılışta sağ tık › Aç demek gerekir. İmzalı/noter onaylı sürüm için `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (uygulamaya özel parola), `APPLE_TEAM_ID` ekleyin.

## 2. Kendi bilgisayarınızda derlemek

Gerekenler: [Bun](https://bun.sh), Node.js 20+, [Rust](https://rustup.rs) ve platformun önkoşulları (Tauri'nin “Prerequisites” sayfası: macOS'ta Xcode, Windows'ta Visual Studio Build Tools + WebView2, Android için Android Studio + NDK).

```bash
npm install            # Tauri CLI'yi kurar
npm run desktop:dev    # masaüstünde geliştirme penceresi
npm run desktop:build  # .dmg / .msi / .AppImage

# Android (Android Studio + NDK kurulu, NDK_HOME ayarlı)
npm run android:init   # gen/android projesini üretir + mikrofon izinlerini ekler + ikonlar
npm run android:dev    # USB ile bağlı tablette canlı çalıştırır
npm run android:build  # APK + AAB

# iPad (yalnızca macOS, Xcode kurulu)
APPLE_DEVELOPMENT_TEAM=XXXXXXXXXX npm run ios:init
npm run ios:dev        # bağlı iPad'de ya da simülatörde çalıştırır
npm run ios:build      # IPA
```

## 3. VST3 / Audio Unit eklentileri (yalnızca masaüstü)

- Mac/Windows uygulaması, bilgisayara kurulu VST3 (Mac'te ayrıca AU) eklentilerini standart klasörlerden bulur ve **Audio FX › VST3 / Audio Units** menüsünde gösterir.
- Eklentiyi çalıştırmak için uygulama **native-plugins** özelliğiyle derlenmelidir: GitHub'da *Run workflow* derken “Desktop: include VST3 hosting” kutusunu işaretleyin, ya da yerelde `npm run tauri build -- --features native-plugins`. Bu kısım **deneyseldir** (Rust `vst3-host` kütüphanesini kullanır; Mac'te en olgun, Windows'ta deneysel). İlk derlemede kütüphane sürümüne göre küçük kod düzeltmeleri gerekebilir.
- Çalışma biçimi “Freeze” gibidir: native eklenti olan iz arka planda eklentiden geçirilerek işlenir ve çalınırken bu işlenmiş dosya kullanılır. Bir şeyi değiştirdiğinizde (nota, parametre, bölge) iz ~1 saniye sonra kendiliğinden yeniden işlenir. Canlı (gerçek zamanlı) izleme, eklentinin kendi penceresi ve native enstrümanlar sonraki adımdır; şimdilik parametreler genel kaydırıcılarla ayarlanır.

## 4. Tablet notları

- **Arayüz:** iPad ve Android tabletlerde dokunmatik hedefler büyür, üst çubuklar tek satırda kalır (dikey modda iki satır). Çentik/ev çubuğu için güvenli alan boşlukları uygulanır, sayfa yakınlaştırma kapalıdır (iki parmak hareketleri uygulamanın kendi zoom'una gider).
- **Ses:** iPad'de sessiz anahtarı açıkken de ses çalar (iPadOS 17+); kayıt sırasında giriş ve çıkış birlikte çalışır. Uygulama arka plandan dönünce ses motoru kendiliğinden devam eder. Çalarken ekran kararmaz.
- **Kayıt:** İlk kayıtta sistem mikrofon izni sorar (Android: RECORD_AUDIO, iPad: Info.ios.plist'teki açıklama). USB ses kartları her iki sistemde de giriş olarak seçilebilir.
- **Dosyalar:** Proje kaydetme ve bounce, masaüstünde sistemin Kaydet penceresiyle; tabletlerde belge seçici ya da paylaşım menüsüyle (“Dosyalar'a Kaydet”, Drive…) yapılır. Açma, sistemin dosya seçicisiyle.
- **Fontlar** uygulamanın içine gömülüdür; uygulama internetsiz tam çalışır.
- **Bilinen sınırlar:** Web MIDI, iPad'de (WebKit) ve Android WebView'da yoktur: harici MIDI klavyeler şimdilik yalnızca masaüstünde (Windows/macOS/Linux) çalışır. Tabletlerde ekran klavyesi (Musical Typing) ve Step Sequencer kullanılabilir. Ses gecikmesi Android'de cihaza bağlıdır; kayıt kaymasını **Settings › Recording latency** ile düzeltin.

## Dosyalar

- `src-tauri/tauri.conf.json`: uygulama adı, sürüm, kimlik (`com.ozmix.studyo`), pencere boyutları
- `src-tauri/Info.plist` / `Info.ios.plist` / `Entitlements.plist`: macOS/iPadOS mikrofon izni, arka planda ses, iPad yönleri
- `src-tauri/capabilities/default.json`: web tarafının kullanabileceği yerel izinler (yalnızca kaydet/aç diyaloğu + seçilen dosyaya yazma)
- `scripts/android-setup.mjs`: üretilen Android projesine mikrofon izinlerini ekler
- `scripts/android-sign.sh`: APK/AAB imzalama (CI)
- `scripts/make-icon.py`, `app-icon.png`: uygulama ikonu (Android/iOS boyutları `tauri icon` ile üretilir)
- `.github/workflows/build.yml`: tüm platformlar için otomatik derleme
