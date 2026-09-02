// =============================================================================
// push-worker.js  --  Cloudflare Worker "push"
//
// Zustandsloser Versandknecht fuer Web-Push-Nachrichten der SC-1911-Flotte.
//
// Er kennt NUR das VAPID-Schluesselpaar. Er hat KEINEN Nextcloud-Zugang und
// KEINE Nutzerdaten: der Worker "landingpage" liest die Abos selbst und
// uebergibt sie im Aufruf. Das war die Bedingung dafuer, die Verschluesselung
// ueberhaupt aus dem Gateway auszulagern -- ein zweiter Ort mit
// NEXTCLOUD_PASSWORD waere ein Rueckschritt gewesen.
//
// Entwurf: docs/superpowers/specs/2026-08-03-push-nachrichten-design.md
//
// -----------------------------------------------------------------------------
// DEPLOY
//   .\deploy-worker.ps1 -Deploy -Only push
//
// SECRETS (im Dashboard oder per API, NIE im Repo):
//   VAPID_PRIVATE_JWK  -- der private Schluessel als JWK-JSON, eine Zeile.
//                         Steht in vapid-schluessel.local.json (gitignored).
//   PUSH_SHARED_SECRET -- gemeinsames Geheimnis, das auch landingpage kennt.
//
// VARIABLE (Klartext, kein Secret):
//   VAPID_SUBJECT      -- optional. mailto:- oder https:-Adresse als Kontakt
//                         fuer die Push-Betreiber. Fallback: die Vereinsseite.
//
// ⚠️ workers.dev fuer diesen Worker ABSCHALTEN. Ein Worker ist sonst ueber
//    seine workers.dev-Adresse oeffentlich erreichbar, auch wenn er nur per
//    Service Binding gedacht ist. Das Shared Secret unten ist der zweite
//    Riegel, nicht der einzige.
//
// ⚠️ Ein Wechsel des VAPID-Schluesselpaars entwertet ALLE bestehenden Abos --
//    wie SESSION_SECRET bei landingpage. Niemand merkt es, es kommen nur keine
//    Nachrichten mehr an. Nur wechseln, wenn der Schluessel abgeflossen ist.
// =============================================================================

const VAPID_SUBJECT_FALLBACK = "https://sc1911heiligenstadt.github.io/";
const JWT_LAUFZEIT_SEKUNDEN = 12 * 60 * 60; // RFC 8292 erlaubt hoechstens 24 h
const PUSH_TTL_SEKUNDEN = 24 * 60 * 60;     // so lange hebt der Dienst sie auf
const RECORD_SIZE = 4096;

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return antwort({ error: "Nur POST" }, 405);
    }

    let body;
    try {
      body = await request.json();
    } catch (_) {
      return antwort({ error: "Kein gueltiges JSON" }, 400);
    }

    // --- Tuersteher -------------------------------------------------------
    // Ohne diese Pruefung koennte jeder mit unserem VAPID-Schluessel
    // Nachrichten an die Geraete unserer Leute schicken: Push-Endpunkte
    // pruefen die Signatur, nicht wer signiert hat.
    if (!env.PUSH_SHARED_SECRET) {
      return antwort({ error: "PUSH_SHARED_SECRET ist nicht gesetzt" }, 500);
    }
    if (!zeitgleicherVergleich(String(body.secret || ""), env.PUSH_SHARED_SECRET)) {
      return antwort({ error: "Nicht berechtigt" }, 403);
    }

    if (!env.VAPID_PRIVATE_JWK) {
      return antwort({ error: "VAPID_PRIVATE_JWK ist nicht gesetzt" }, 500);
    }

    const abos = Array.isArray(body.abos) ? body.abos : [];
    const nachricht = body.nachricht || {};
    if (!abos.length) return antwort({ ok: true, zugestellt: 0, tot: [], fehler: [] }, 200);

    // Der Text geht verschluesselt raus -- Apple und Google stellen zu, lesen
    // koennen sie ihn nicht. Trotzdem stehen hier bewusst keine Namen oder
    // Dokumenttitel, siehe Spec: die Nachricht landet auf dem Sperrbildschirm.
    const klartext = new TextEncoder().encode(JSON.stringify({
      titel: String(nachricht.titel || "SC 1911").slice(0, 100),
      text: String(nachricht.text || "").slice(0, 200),
      ziel: String(nachricht.ziel || "/ToolsUebersicht/").slice(0, 200)
    }));

    let vapidKey;
    try {
      vapidKey = await ladeVapidSchluessel(env.VAPID_PRIVATE_JWK);
    } catch (e) {
      return antwort({ error: "VAPID_PRIVATE_JWK unbrauchbar: " + e.message }, 500);
    }
    const vapidPublicB64 = await oeffentlicherVapidTeil(env.VAPID_PRIVATE_JWK);
    const subject = String(env.VAPID_SUBJECT || VAPID_SUBJECT_FALLBACK);

    const tot = [];
    const fehler = [];
    let zugestellt = 0;

    // Bewusst NACHEINANDER statt Promise.all: die Haeppchen kommen schon
    // vorportioniert von landingpage (zehn Stueck), und ein Schwall
    // gleichzeitiger Verbindungen bringt bei der Groesse nichts ausser
    // Spitzenlast.
    for (const abo of abos) {
      try {
        const res = await sendeAnEinGeraet(abo, klartext, vapidKey, vapidPublicB64, subject);
        if (res.tot) tot.push(abo.id);
        else if (res.ok) zugestellt++;
        else fehler.push({ id: abo.id, status: res.status });
      } catch (e) {
        fehler.push({ id: abo.id, meldung: String(e && e.message || e) });
      }
    }

    return antwort({ ok: true, zugestellt, tot, fehler }, 200);
  }
};

// ---------------------------------------------------------------------------
// Versand an ein einzelnes Geraet
// ---------------------------------------------------------------------------
async function sendeAnEinGeraet(abo, klartext, vapidKey, vapidPublicB64, subject) {
  const endpoint = String(abo.endpoint || "");
  if (!/^https:\/\//i.test(endpoint)) throw new Error("Endpunkt ist keine https-Adresse");

  const koerper = await verschluessle(klartext, abo.p256dh, abo.auth);
  const jwt = await baueVapidJwt(new URL(endpoint).origin, subject, vapidKey);

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": "vapid t=" + jwt + ", k=" + vapidPublicB64,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "TTL": String(PUSH_TTL_SEKUNDEN),
      // ⚠️ "high" ist Michel-Vorgabe vom 2026-08-03 (vorher "normal"). Die vier
      // Stufen aus RFC 8030 sagen dem Push-Dienst, wie wichtig eine Nachricht
      // gegenueber dem Akkustand ist: bei niedriger Stufe darf er sie
      // zurueckhalten, solange das Geraet im Energiesparmodus liegt, und
      // gesammelt zustellen, wenn es ohnehin aufwacht. "high" ist die hoechste
      // Stufe und heisst: dafuer darf das Geraet weckt werden.
      //
      // Der Preis ist Akku, und zwar auf JEDEM Geraet der Flotte -- die Stufe
      // haengt am Versand, nicht am Empfaenger. Wer sie wieder senken will,
      // aendert sie hier fuer alle; einzelne Anlaesse zu staffeln ginge nur
      // ueber ein Feld je Nachricht, das es bewusst nicht gibt.
      "Urgency": "high"
    },
    body: koerper
  });

  // 404/410 heisst: dieses Abo gibt es nicht mehr (App geloescht, Geraet
  // zurueckgesetzt). Das ist kein Fehler, sondern die Aufforderung aufzuraeumen.
  if (res.status === 404 || res.status === 410) return { tot: true };
  if (res.ok) return { ok: true };
  return { ok: false, status: res.status };
}

// ---------------------------------------------------------------------------
// VAPID: JWT nach RFC 8292, mit ES256 signiert
// ---------------------------------------------------------------------------
async function ladeVapidSchluessel(jwkText) {
  const jwk = typeof jwkText === "string" ? JSON.parse(jwkText) : jwkText;
  return crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d, ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
}

// Der oeffentliche Teil im Header k= ist der unkomprimierte Punkt 0x04||X||Y.
async function oeffentlicherVapidTeil(jwkText) {
  const jwk = typeof jwkText === "string" ? JSON.parse(jwkText) : jwkText;
  const x = base64urlZuBytes(jwk.x);
  const y = base64urlZuBytes(jwk.y);
  const punkt = new Uint8Array(65);
  punkt[0] = 4;
  punkt.set(x, 1);
  punkt.set(y, 33);
  return bytesZuBase64url(punkt);
}

async function baueVapidJwt(aud, sub, key) {
  const kopf = { typ: "JWT", alg: "ES256" };
  const nutz = {
    aud,                                                     // NUR das Origin, nicht der volle Pfad
    exp: Math.floor(Date.now() / 1000) + JWT_LAUFZEIT_SEKUNDEN,
    sub
  };
  const eingabe = bytesZuBase64url(new TextEncoder().encode(JSON.stringify(kopf)))
    + "." + bytesZuBase64url(new TextEncoder().encode(JSON.stringify(nutz)));

  // WebCrypto liefert die ECDSA-Signatur bereits als r||s (64 Bytes) -- genau
  // das, was JWS verlangt. Kein DER-Auspacken noetig.
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(eingabe)
  );
  return eingabe + "." + bytesZuBase64url(new Uint8Array(sig));
}

// ---------------------------------------------------------------------------
// Verschluesselung: aes128gcm (RFC 8188) mit dem Schluesselaufbau aus RFC 8291
//
// Reihenfolge, jeder Schritt zaehlt:
//   1. ephemeres P-256-Paar erzeugen (pro Nachricht neu, NICHT der VAPID-Key)
//   2. ecdh = ECDH(ephemeral_privat, geraet_oeffentlich)
//   3. IKM  = HKDF(salt=auth_secret, ikm=ecdh, info="WebPush: info"||0||ua||as)
//   4. CEK  = HKDF(salt=zufall,      ikm=IKM,  info="Content-Encoding: aes128gcm"||0)[0..16]
//      NONCE= HKDF(salt=zufall,      ikm=IKM,  info="Content-Encoding: nonce"||0)[0..12]
//   5. Klartext + 0x02 als Abschlussmarke, dann AES-128-GCM
//   6. Koerper = salt(16) || rs(4) || idlen(1) || as_public(65) || ciphertext
// ---------------------------------------------------------------------------
async function verschluessle(klartext, p256dhB64, authB64) {
  const geraetPub = base64urlZuBytes(String(p256dhB64 || ""));
  const authSecret = base64urlZuBytes(String(authB64 || ""));
  if (geraetPub.length !== 65) throw new Error("p256dh hat " + geraetPub.length + " statt 65 Bytes");
  if (authSecret.length !== 16) throw new Error("auth hat " + authSecret.length + " statt 16 Bytes");

  const eigenes = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]
  );
  const eigenesPub = new Uint8Array(await crypto.subtle.exportKey("raw", eigenes.publicKey));

  const geraetKey = await crypto.subtle.importKey(
    "raw", geraetPub, { name: "ECDH", namedCurve: "P-256" }, false, []
  );
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: geraetKey }, eigenes.privateKey, 256
  ));

  const salt = crypto.getRandomValues(new Uint8Array(16));

  // Schritt 3 -- der Schluesselaufbau, der Web Push von reinem RFC 8188 trennt
  const keyInfo = verbinde(
    new TextEncoder().encode("WebPush: info"), new Uint8Array([0]), geraetPub, eigenesPub
  );
  const ikm = await hkdf(authSecret, ecdh, keyInfo, 32);

  const cekBytes = await hkdf(salt, ikm, verbinde(
    new TextEncoder().encode("Content-Encoding: aes128gcm"), new Uint8Array([0])
  ), 16);
  const nonce = await hkdf(salt, ikm, verbinde(
    new TextEncoder().encode("Content-Encoding: nonce"), new Uint8Array([0])
  ), 12);

  const cek = await crypto.subtle.importKey("raw", cekBytes, { name: "AES-GCM" }, false, ["encrypt"]);

  // 0x02 markiert den letzten Record. Ohne die Marke verwirft der Browser die
  // Nachricht stillschweigend -- sie kommt an und wird nie angezeigt.
  const mitMarke = verbinde(klartext, new Uint8Array([2]));
  const geheim = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, tagLength: 128 }, cek, mitMarke
  ));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, RECORD_SIZE, false); // big endian
  return verbinde(salt, rs, new Uint8Array([eigenesPub.length]), eigenesPub, geheim);
}

// HKDF = extract (HMAC mit salt) + expand (HMAC mit info||0x01), gekuerzt auf laenge
async function hkdf(salt, ikm, info, laenge) {
  const saltKey = await crypto.subtle.importKey("raw", salt, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const prk = new Uint8Array(await crypto.subtle.sign("HMAC", saltKey, ikm));
  const prkKey = await crypto.subtle.importKey("raw", prk, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const out = new Uint8Array(await crypto.subtle.sign("HMAC", prkKey, verbinde(info, new Uint8Array([1]))));
  return out.slice(0, laenge);
}

// ---------------------------------------------------------------------------
// Kleinkram
// ---------------------------------------------------------------------------
function verbinde() {
  let laenge = 0;
  for (let i = 0; i < arguments.length; i++) laenge += arguments[i].length;
  const out = new Uint8Array(laenge);
  let pos = 0;
  for (let i = 0; i < arguments.length; i++) { out.set(arguments[i], pos); pos += arguments[i].length; }
  return out;
}

function base64urlZuBytes(s) {
  const roh = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const voll = roh + "=".repeat((4 - (roh.length % 4)) % 4);
  const bin = atob(voll);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesZuBase64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Laufzeitkonstanter Vergleich -- ein frueh abbrechendes === verraet ueber die
// Antwortzeit, wie viele Zeichen des Secrets stimmen.
function zeitgleicherVergleich(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function antwort(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
