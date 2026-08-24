# 🌐 N2 Mesh — Czat P2P

**Bezserwerowy czat peer-to-peer działający na statycznym hostingu (GitHub Pages).**
Bez serwera, bez bazy danych, bez kont — wystarczy WebRTC i publiczny broker
MQTT używany tylko do sygnalizacji.

**Na żywo: https://bartoszosiej.github.io/n2-mesh/**

## Jak to działa

```
  ┌─────────────┐   kanał danych WebRTC   ┌─────────────┐
  │  Peer A     │◄───────────────────────►│  Peer B     │
  │ (Twoja karta)│      (bezpośrednio)     │ (jego karta)│
  └──────┬──────┘                         └──────┬──────┘
         │   SDP offer/answer/ICE przez         │
         │   publiczny temat MQTT (tylko sygnał) │
         ▼                                       ▼
   ┌─────────────────────────────────────────────────┐
   │   Publiczny broker MQTT (temat per pokój)       │
   │   obecność + sygnalizacja + fallback wiadomości │
   └─────────────────────────────────────────────────┘
```

1. **Peerowie ogłaszają swoją obecność** na temacie MQTT per pokój (bez konta,
   publiczny broker — tak samo, jak komunikatory odnajdują się nawzajem).
2. Gdy dwóch peerów się zobaczy, wymieniają **oferty/odpowiedzi/ICE WebRTC**
   przez ten temat (klasyczny wzorzec serwera sygnalizacji, jak w PeerJS).
   Broker tylko *przedstawia* peerów — nigdy nie widzi treści wiadomości.
3. Po połączeniu wiadomości czatu podróżują po **kanale danych WebRTC**
   bezpośrednio między przeglądarkami — prawdziwe peer-to-peer.
4. W sieciach blokujących WebRTC (CGNAT operatorów komórkowych) wiadomości
   płyną przez temat MQTT jako automatyczny fallback. Odbiorcy deduplikują po
   id wiadomości, więc P2P pozostaje głównym kanałem i nic nie ginie.

### Dlaczego nie trackery WebTorrent?

Oryginalna wersja znajdowała peerów przez publiczne trackery WebSocket
WebTorrent (`tracker.webtorrent.dev`, `tracker.openwebtorrent.com`). Te
trackery przyjmują announce i widzą rój, ale **przestały przekazywać oferty
WebRTC** między peerami — zweryfikowane na żywo: dwóch peerów w tym samym
roju (`complete=2`) i zero ofert w obie strony. Ponieważ przeglądarkowa wersja
WebTorrent może używać tylko trackerów WebSocket (w przeglądarce nie ma
UDP/DHT), peerowie nigdy nie mogli się odnaleźć i P2P nie działało.
Sygnalizacja przez relay MQTT utrzymuje aplikację w pełni bezserwerową,
działa dziś i jest wzorcem używanym przez prawdziwe komunikatory.

## Funkcje

- 🔗 **Pokoje** — ta sama nazwa pokoju = ten sam temat sygnalizacji = ta sama
  grupa peerów
- 💬 **Prawdziwe wiadomości P2P** — przez kanały danych WebRTC, z fallbackiem
  przez MQTT
- 🏷️ Nicki, licznik peerów, status połączenia
- 🔗 Linki do pokoi do udostępniania (`#/nazwa-pokoju`)
- 🌙 Ciemny UI, dostępny z klawiatury, zero zależności (bez CDN, bez buildu)

## Pliki

| Plik | Przeznaczenie |
|---|---|
| `index.html` | Powłoka single-page |
| `app.js` | Sieć (WebRTC + sygnalizacja MQTT) — zero zależności |
| `core.js` | Warstwa czystej logiki (bajty, id wiadomości, dedup, parsowanie pokoi, kodek pakietów MQTT 3.1.1) — testowalna bez przeglądarki |
| `style.css` | Ciemny motyw aurora |

## Testy i utwardzanie (sweep NV2.0)

Logika wiadomości mieszka w `core.js`, dzięki czemu można ją testować
headless. Suita ma **49/49 zielonych** (`npm test`, wbudowany `node:test`
Node, zero zależności):

- `tests/core.test.js` (22) — funkcjonalne: bajty, id wiadomości, dedup,
  parsowanie pokoi, round-tripy pakietów MQTT
- `tests/core.rigorous.test.js` (27) — **rygorystyczne**: testy fuzz i
  property na deterministycznym PRNG (mulberry32, każdy przebieg
  odtwarzalny)

Najważniejsze pokrycie: każda granica remaining-length MQTT 3.1.1
(0 → 268 435 455) bajt po bajcie, 5 000 losowych round-tripów
encode→decode, 2 000 losowych fuzz round-tripów tematów/payloadów,
5 000 śmieciowych buforów (nigdy nie rzuca), uszkodzone pakiety → `null`,
bezpieczne dla punktów kodowych przycinanie nazwy pokoju, mapa dedup
ograniczona przy 3 000 wstawień hurtowych, 200 000 wygenerowanych id
wiadomości bez ani jednej kolizji.

Sweep znalazł i naprawił prawdziwe bugi: pomyłkę flagi QoS vs DUP przy
pomijaniu packet-id, przeciek payloadów poza 2-bajtową długością
remaining-length, crash `parseRoom(null)` oraz rozcinanie par surrogatów
w nazwach pokoi na limicie 48 znaków. Szczegóły w
[`TEST_REPORT.md`](TEST_REPORT.md).

## Uruchomienie lokalne

```bash
python3 -m http.server 8080
# otwórz http://localhost:8080 (i drugą kartę, żeby porozmawiać ze sobą)
```

## Wdrożenie

Push na `main` — GitHub Actions (`deploy.yml`) publikuje pliki statyczne na
GitHub Pages automatycznie.

## Nota bezpieczeństwa

- Wiadomości podróżują **peer-to-peer** po kanałach danych WebRTC, gdy tylko
  to możliwe; broker MQTT wykonuje sygnalizację i jest fallbackiem na
  restrykcyjnych sieciach.
- To mesh w skali demo: peerowie muszą być online jednocześnie. Nie ma
  historii — gdy wyjdziesz, pokój znika.
