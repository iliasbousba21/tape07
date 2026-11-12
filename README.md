# REEL–7 · field player

REEL–7 is een muziekspeler in de stijl van een draagbare tape-/field-recorder. Je zet je eigen muziek erop (mp3 en andere formaten), en speelt die af met een draaibare reel, varispeed zoals bij tape, en een paar eenvoudige effecten. Het is een web-app die ook als Android-app (APK) te installeren is, en die daarna offline werkt.

> **Geen officiële app.** REEL–7 is een onafhankelijke hommage, geïnspireerd op hardware-recorders zoals de TP–7. Het is niet gemaakt door, verbonden met of goedgekeurd door Teenage Engineering, en gebruikt geen logo's, merknamen of productfoto's van hen.

## Wat zit erin

- **Eigen muziek laden**: meerdere bestanden tegelijk via de knop `tape` → `+ load`. Elk bestand wordt als kopie in de app bewaard (IndexedDB), dus je muziek blijft staan na herladen of herstarten, ook offline.
- **Tape (bibliotheek)**: titel en artiest (uit ID3-tags bij mp3, anders de bestandsnaam) en duur. Volgorde aanpassen door aan `≡` te slepen, één nummer wissen (`×`, twee keer tikken) of de hele tape wissen (`erase` → `sure?`).
- **Transport**: play/pauze (met korte tape-start/-stop), stop, vorige/volgende, zoeken door op de golfvorm te tikken of te slepen.
- **Reel / jog-wiel**: vinger op de reel = de tape stopt; draaien = scratchen. Je hoort het nummer zelf, vooruit én achteruit, ook bij een langzame crawl of een snelle backspin. Een zwiep laat de reel uitlopen met traagheid; daarna speelt hij verder vanaf die plek, op de gekozen varispeed.
- **Varispeed**: schuif `speed` van 0,50× tot 2,00×. De toonhoogte gaat mee, zoals bij echte tape. Klikt vast op 1,00×; dubbeltik of `=1` zet hem terug.
- **Knoppen (effecten)**: `vol`, `lp · tone · hp` (links low-pass, rechts high-pass, midden vlak), `drive` (tape-saturatie), `echo`, `spring` (veerreverb) en `wow` (wow & flutter). Sleep omhoog/omlaag, dubbeltik = reset. `fx` zet alle effecten in één keer uit (bypass).
- **A–B-loop en cues**: `a–b` drie keer tikken: A zetten, B zetten (loop aan), wissen. `cue` zet een marker (max. 8 per nummer), ingedrukt houden wist ze; `‹ cue` / `cue ›` springen ertussen. Loops en cues worden per nummer bewaard.
- **Display**: tijdcode `uu:mm:ss.hh`, nummer, snelheid, golfvorm met cues/loop en L/R-niveaumeters.
- **Memo**: neemt met de microfoon een take op en zet die als `take 001`, `take 002`, … op de tape (als WAV).
- **Vergrendelscherm en koptelefoon**: play/pauze/volgende/vorige/zoeken werken via de mediabediening van Android (Media Session).
- **Offline**: de app zelf wordt door een service worker bewaard; je audio staat in IndexedDB.
- Staand en liggend: liggend lijkt de indeling op een horizontale recorder (reel rechts, display en knoppen links).
- Toetsenbord (optioneel): spatie = play, ←/→ = 5 s zoeken, shift+←/→ = vorig/volgend nummer, `[` `]` = snelheid, `l` = tape, `a` = a–b, `m` = cue.

## Ondersteunde formaten

mp3, wav, m4a/aac, ogg (vorbis), opus, flac en webm — alles wat de browser van je toestel kan decoderen. Chrome op Android speelt al deze formaten normaal af. Een bestand dat het toestel niet kan lezen, wordt overgeslagen met een melding op het display.

## Online

De web-app staat op https://iliasbousba21.github.io/tape07/ (gepubliceerd vanaf `main` via GitHub Actions) en gebruikt dezelfde scratch-engine als de APK.

Open die link in **Chrome** op je telefoon. Tik op het menu (drie puntjes) en kies **App installeren** of **Toevoegen aan startscherm**. Daarna kun je REEL–7 vanaf je startscherm openen en je eigen mp3's laden. De eerste keer is een internetverbinding nodig; daarna werkt de app zelf ook offline. Je muziek blijft in de app staan.

## Android-app (APK)

Er is ook een installeerbare app, zodat je REEL–7 niet alleen als PWA hoeft te gebruiken. Die bevat dezelfde speler, heeft geen server nodig tijdens het afspelen, en bewaart je muziek in de app.

Download: https://github.com/iliasbousba21/tape07/releases/download/v1.1.0/reel7-1.1.0.apk

1. Open die link in Chrome op je telefoon en download de APK (of stuur het bestand naar je toestel).
2. Tik op het bestand. Als Android blokkeert, tik op **Instellingen** en zet **Toestaan vanuit deze bron** aan (soms heet dat **Onbekende apps installeren**).
3. Tik op **Installeren** en open **REEL–7**.
4. Tik op `tape` → `+ load` en kies mp3, wav, m4a, flac of een ander audiobestand. De bestandskiezer van Android geeft de app alleen dat bestand; je hoeft geen brede opslagtoegang te geven. Voor een memo vraagt de app de microfoon.

Praktisch minimum: **Android 10** (API 29) met een bijgewerkte **Android System WebView**. De scratch-engine gebruikt AudioWorklet. Op een oudere WebView speelt de app nog wel, maar dan zonder achteruit scratchen — het display zegt dat.

De APK is een debug-build om te sideloaden, niet een Play Store-release. Installeer je later een nieuwere build en Android meldt een conflict, verwijder de oude REEL–7 eerst. Je muziek staat in de app en gaat daarbij weg.

## Lokaal draaien

Vereist: Node.js 18 of nieuwer.

```bash
cd reel-7
npm install
npm run dev        # ontwikkelserver, ook bereikbaar op je wifi-netwerk
npm run build      # productieversie in dist/
npm run preview    # dist/ lokaal bekijken
```

`dist/` bevat alleen statische bestanden en kan op elke HTTPS-host gezet worden (bv. GitHub Pages, Netlify, Cloudflare Pages). De app werkt ook vanuit een submap.

`npm run icons` maakt de app-iconen opnieuw (vereist Python 3 met Pillow).

De Android-APK opnieuw bouwen (Android SDK 36, JDK 21):

```bash
npm run android:debug
```

Het bestand staat daarna in `android/app/build/outputs/apk/debug/`. De keystore hoort niet in deze repo; de GitHub-release gebruikt de debug-sleutel van die build.

## Installeren op Android

1. Zet de map `dist/` op een **HTTPS**-adres (installeren en de service worker werken niet via gewone `http://`, behalve op `localhost`).
2. Open dat adres in **Chrome** op je Android-telefoon.
3. Tik op het menu `⋮` → **App installeren** (of **Toevoegen aan startscherm**).
4. Open REEL–7 vanaf je startscherm. Tik op `tape` → `+ load` en kies je muziek.

Tip: de eerste keer vraagt de app de browser om opslag permanent te houden, zodat Android je muziek niet zomaar opruimt.

## Lettertypes

De app gebruikt **Geist**, **Geist Mono** en **Geist Pixel** (SIL Open Font License), lokaal meegeleverd in `public/fonts/` (licentie: `public/fonts/OFL-Geist.txt`). Er worden geen fonts of scripts van externe servers geladen.

## Privacy

Geen accounts, geen tracking, geen analytics, geen server. Je muziek en opnames blijven op je toestel.

## Bekende beperkingen

- Varispeed tijdens gewoon afspelen loopt van 0,50× tot 2,00×. De toonhoogte gaat mee. Scratchen met de reel kan sneller en ook achteruit; heel hoge snelheden worden iets dof gefilterd zodat het niet gaat aliasen.
- Een nummer moet eerst gedecodeerd worden naar het geheugen. Dat gebeurt buiten de UI-thread. Heel lange of zware bestanden (ruwweg meer dan een kwartier stereo, of meer dan 100 MB) vallen terug op gewone weergave: het display meldt dat scratch dan niet beschikbaar is, afspelen wel.
- Golfvormen worden op de achtergrond berekend; bij bestanden groter dan ±160 MB of formaten die de decoder niet aankan, toont het display een bewegende tapestrook in plaats van een golfvorm.
- Hoeveel muziek je kwijt kunt, hangt af van de vrije opslag op je toestel.
- Vergrendelscherm en koptelefoonknoppen lopen via Media Session, met een stil audiokanaal zodat Android de speler niet meteen stopzet. In de APK blijft dat zo goed mogelijk werken; een heel oude WebView of een agressieve accubesparing kan achtergrondweergave nog steeds onderbreken. Tijdens een memo-opname houdt de app het scherm aan.
- De APK-handtekening wisselt per build. Een update over een oudere installatie heen kan daardoor geweigerd worden; verwijder de app dan eerst.
