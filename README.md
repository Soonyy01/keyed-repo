# Keyed

**Your key to the inner circle.** Creator keys on Robinhood Chain.

Kreator bisa membuka club dengan jumlah key yang tetap. Pengguna membeli dan menjual key dalam ETH di Robinhood Chain, dan sebagian fee dibagikan ke holder.

```
keyed/
├── website/          ← website statis (HTML + JS, tanpa build)
│   └── config.js     ← satu-satunya file yang perlu kamu edit
├── contract/         ← smart contract + test (Foundry)
│   ├── src/Keyed.sol
│   └── test/Keyed.t.sol
└── netlify.toml      ← supaya Netlify langsung tahu folder mana yang di-online-kan
```

Kalau `CONTRACT_ADDRESS` di `config.js` masih kosong, website jalan dalam **demo mode** (data contoh, uang mainan).

---

## 1. Clone

```bash
git clone https://github.com/USERNAME/keyed.git
cd keyed
```

Untuk mencoba di komputer sendiri:

```bash
cd website
python3 -m http.server 8080
```

Lalu buka http://localhost:8080.

## 2. Siapkan wallet

1. Pasang **MetaMask** di Chrome. Buat wallet baru khusus untuk proyek ini dan simpan seed phrase-nya baik-baik.
2. Tambahkan **Robinhood Chain** ke MetaMask (halaman `/deploy.html` juga akan menambahkannya otomatis):
   - Network name: `Robinhood Chain`
   - RPC URL: `https://rpc.mainnet.chain.robinhood.com`
   - Chain ID: `4663`
   - Currency symbol: `ETH`
   - Block explorer: `https://robinhoodchain.blockscout.com`
3. Isi wallet dengan sedikit **ETH di Robinhood Chain** untuk biaya gas (bridge dari Ethereum/Arbitrum).
   > Wallet Privy (email/X) bisa di-*export* ke MetaMask, atau kirim ETH dari wallet Privy ke MetaMask.

## 3. Deploy kontrak

### Cara paling mudah: halaman deploy

Buka `https://situsmu/deploy.html`, klik **Connect wallet**, lalu **Deploy contract**. Halaman ini otomatis pindah ke Robinhood Chain, men-deploy, lalu menampilkan baris `CONTRACT_ADDRESS` untuk disalin ke `config.js`.

### Cara A: Remix (lewat browser, paling gampang)

1. Buka https://remix.ethereum.org.
2. Buat file `Keyed.sol`, lalu salin isi `contract/src/Keyed.sol` ke sana.
3. Buka tab **Solidity Compiler**:
   - Versi: **0.8.24**.
   - Di *Advanced Configurations*, centang **Enable optimization**, runs **200**.
     > ⚠️ **Wajib.** Tanpa ini kontrak terlalu besar dan deploy gagal.
   - Klik **Compile**.
4. Buka tab **Deploy & Run**:
   - Environment: **Injected Provider – MetaMask**. Pastikan MetaMask di **Robinhood Chain** (chain ID 4663).
   - Pilih kontrak **Keyed**, lalu klik **Deploy** dan konfirmasi.
5. Salin **alamat kontrak** (`0x...`) dari bagian *Deployed Contracts*.

### Cara B: Foundry (kalau sudah terpasang)

```bash
cd contract
forge install foundry-rs/forge-std --no-git
forge test
forge create src/Keyed.sol:Keyed \
  --rpc-url https://rpc.mainnet.chain.robinhood.com \
  --private-key PRIVATE_KEY_KAMU --broadcast
```

Wallet yang men-deploy otomatis jadi pemilik, dan fee 1% platform masuk ke wallet ini.

## 4. Isi config.js

Edit `website/config.js`:

```js
CONTRACT_ADDRESS: "0xALAMAT_KONTRAK_KAMU",
NETWORK: "mainnet",          // Robinhood Chain (4663). "testnet" = Robinhood Chain Testnet (46630)
X_URL: "https://x.com/akunmu",
```

Lalu commit dan push:

```bash
git add website/config.js
git commit -m "Set contract address"
git push
```

## 5. Online-kan (gratis, auto-update setiap push)

### Netlify

1. Buka https://app.netlify.com dan login pakai GitHub.
2. Pilih **Add new site → Import an existing project → GitHub**, lalu pilih repo `keyed`.
3. Semua setting sudah terbaca dari `netlify.toml`. Langsung klik **Deploy**.
4. Ganti nama situs di **Site configuration → Change site name**.

### Vercel (alternatif)

1. Buka https://vercel.com/new dan import repo `keyed`.
2. **Root Directory:** `website`. **Framework Preset:** Other. Klik **Deploy**.

Setelah itu, setiap kali kamu `git push`, situs ter-update otomatis.

## 6. Testnet (opsional)

Untuk uji coba tanpa uang asli, ubah `NETWORK: "testnet"` di `config.js` (Robinhood Chain Testnet, chain ID 46630, RPC `https://rpc.testnet.chain.robinhood.com`), deploy ulang lewat `/deploy.html`, lalu isi alamat kontrak testnet-nya. Kembalikan ke `"mainnet"` saat live.

## Mengambil fee platform

Buka website dengan wallet yang men-deploy kontrak, lalu buka **Portfolio → Creator earnings → Withdraw**.

---

## Cara kerja

**Harga key**
- Key ke-n berharga (n − 1)² ÷ 16.000 ETH.
- Key ke-11 ≈ 0,006 ETH. Key ke-101 ≈ 0,62 ETH.

**Fee 4% per transaksi**
- 1% untuk platform.
- 3% untuk kreator. Kreator bisa membagi sebagian ke holder, dan bagiannya hanya bisa naik.

**Aturan club**
- Kreator dapat key #1 gratis saat launch.
- Jumlah maksimum key (2–5.000) ditentukan saat launch dan tidak bisa diubah.
- Key terakhir di sebuah club tidak bisa dijual.

**Keamanan dana**
- Pemilik kontrak **tidak bisa** mengambil ETH milik pengguna.
- Pemilik hanya bisa mengganti alamat penerima fee platform.

## Batasan

- **Kontrak belum diaudit.** Ada 23 test, termasuk uji solvabilitas acak dan reentrancy, tapi itu bukan pengganti audit. Gunakan dengan risiko sendiri.
- **Handle X tidak diverifikasi.** Siapa pun bisa menulis handle apa saja.
- **RPC publik gratis punya batas.** Kalau ramai, isi `RPC_URL` dengan RPC Robinhood Chain dari Alchemy, QuickNode atau Chainstack.
- **Pengguna HP** membuka situs lewat browser di dalam aplikasi wallet (MetaMask, Rabby, Trust Wallet), atau login lewat Privy (email/X).
