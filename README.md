# Pablo-päiväkirja 🐶

Yksinkertainen PWA-sovellus MAS-pentu Pablon (s. 28.4.2026) vessataukojen, ruokailujen ja
leikkihetkien kirjaamiseen — sekä älykäs muistutus siitä, milloin Pablo pitää viedä ulos.

## Ominaisuudet

- **Kirjaukset yhdellä napilla:** 💛 Pissa, 💩 Kakka (ulkona / sisällä), 🍖 Ruoka, 🎾 Leikki,
  🐾 Tyhjä reissu (käytiin ulkona, ei tullut mitään)
- **Älykäs ennuste** seuraavasta vessatauosta:
  - Ikäpohjainen perusväli (10–12 vk pennulla ~90 min)
  - Oppii Pablon oman rytmin kirjausten kertyessä (mediaaniväli, päivittyy jatkuvasti)
  - Ruokailu aikaistaa ennustetta (+20 min ruoasta), leikki samoin (+15 min)
  - Tyhjä reissu siirtää ennustetta 25 min eteenpäin
  - **Sisävahingot kiristävät väliä:** mediaani vahinkoja edeltäneistä väleistä × 0.85.
    Suojaukset poikkeuspäiviä vastaan: alle 30 min tuplapissat ohitetaan, leikin
    lähellä (-60/+30 min) tapahtuneet vahingot ohitetaan innostuspissoina, ja
    kiristys hälvenee lineaarisesti 48 h kuluessa viimeisimmästä vahingosta
- **Push-ilmoitukset** molempien puhelimiin (Cloud Scheduler tarkistaa 10 min välein).
  Hiljaiset tunnit 00:00–08:00 (vakireissu ulos ~05:30 hoidetaan omalla herätyksellä).
  Ilmoitusten väli vähintään 45 min. Yön välejä (23–08) ei käytetä rytmin oppimiseen.
- **Tilastot:** onnistumisprosentti ulkona, pissat/kakat per päivä
- Ei kirjautumista — salainen linkki, jonka vain me tiedämme

## Arkkitehtuuri

- **Cloud Run** (`pablo-tracker`, europe-north1, projekti `illusian-pitch-processor`):
  Node.js/Express, tarjoilee PWA:n ja APIn salaisen polun (`APP_TOKEN`) takana
- **Firestore**: kokoelmat `pablo_events`, `pablo_subs`, `pablo_meta`
  (eroteltu Pitch Processorin datasta etuliitteellä)
- **Cloud Scheduler** (`pablo-reminders`): POST `…/api/check-reminders` 10 min välein
- **Web Push** VAPID-avaimilla (`.env`, ei versionhallintaan) — toimii iPhonella,
  kun sovellus on lisätty kotivalikkoon

## Deploy

```bash
./deploy.sh
```

## Asennus puhelimeen (iPhone)

1. Avaa salainen linkki Safarissa
2. Jaa-nappi → **Lisää Koti-valikkoon**
3. Avaa Pablo-ikoni kotivalikosta → paina 🔔 → salli ilmoitukset
