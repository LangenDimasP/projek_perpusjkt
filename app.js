const express = require("express");
const mysql = require('mysql2/promise');
const bodyParser = require("body-parser");
const path = require("path");
const session = require('express-session'); // <-- BARU
const MySQLStore = require('express-mysql-session')(session);
const bcrypt = require('bcrypt'); // <-- BARU

const app = express();
const port = 3000;

const ExcelJS = require('exceljs');

const multer = require("multer");
const xlsx = require("xlsx");
const fs = require("fs"); // Modul 'fs' untuk mengelola file

// Konfigurasi Multer untuk menyimpan file upload sementara
const upload = multer({ dest: "uploads/" });

const toYYYYMMDD = (date) => {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};


const pool = mysql.createPool({
    host: "localhost",
    user: "root",
    password: "",
    database: "penjadwalan_perpusjkt",
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    timezone: "+07:00"
});

const sessionStore = new MySQLStore({
    host: "localhost",
    user: "root",
    password: "",
    database: "penjadwalan_perpusjkt",
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    timezone: "+07:00"
});

async function logAdminAction(req, action, table, recordId, description) {
    if (!req.session.user) return;
    await pool.query(
        "INSERT INTO admin_logs (username, action, table_name, record_id, description) VALUES (?, ?, ?, ?, ?)",
        [req.session.user.username, action, table, recordId, description]
    );
}


// Setup Middleware
app.use(session({
    key: 'perpusjkt.sid', // nama cookie, boleh diganti
    secret: 'perpusjkt_skey', // ganti dengan string acak yang kuat
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 1000 * 60 * 60 * 24 * 7 // 7 hari
    }
}));
app.set("view engine", "ejs"); // Set EJS sebagai view engine
app.set("views", path.join(__dirname, "views")); // Tentukan lokasi folder views
app.use(bodyParser.urlencoded({ extended: true })); // Untuk mem-parsing body dari request form
app.use(express.static(path.join(__dirname, "public"))); // (Opsional) Untuk file statis seperti CSS/JS nanti
app.use(express.json());
app.use(express.static("public"));
app.use((req, res, next) => {
  res.locals.currentPath = req.path;
  res.locals.user = req.session.user; // <-- BARU: kirim info user ke view
  next();
});

const requireLogin = (req, res, next) => {
    if (!req.session.userId) {
        return res.redirect('/login');
    }
    next();
};

const redirectIfLoggedIn = (req, res, next) => {
    if (req.session.userId) {
        return res.redirect('/'); // Arahkan ke dashboard jika sudah login
    }
    next();
};
const GUEST_SECRET_KEY = 'perpusjkt-guest'; // Kunci rahasia untuk akses tamu
app.get('/view/:secretKey', async (req, res) => {
    // 1. Validasi Kunci Rahasia
    if (req.params.secretKey !== GUEST_SECRET_KEY) {
        return res.status(404).send('Halaman tidak ditemukan.');
    }

    try {
        const toYYYYMMDD = (date) => {
            const d = new Date(date);
            const year = d.getFullYear();
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        };

        // --- PERBAIKAN LOGIKA TANGGAL DI SINI ---
        let referenceDate = new Date(); // Default ke hari ini
        if (req.query.start && /^\d{4}-\d{2}-\d{2}$/.test(req.query.start)) {
            // Jika ada parameter 'start' dan formatnya benar (YYYY-MM-DD)
            // Buat tanggal dengan cara yang lebih aman untuk menghindari masalah timezone
            const [year, month, day] = req.query.start.split('-').map(Number);
            referenceDate = new Date(year, month - 1, day);
        }

        const dayOfWeek = referenceDate.getDay(); // 0=Minggu, 1=Senin, ...
        const startDate = new Date(referenceDate);
        startDate.setDate(startDate.getDate() - dayOfWeek); // Set ke hari Minggu di minggu referensi
        
        const endDate = new Date(startDate);
        endDate.setDate(endDate.getDate() + 6); // Set ke hari Sabtu di minggu yang sama

        const tanggalMulai = toYYYYMMDD(startDate);
        const tanggalAkhir = toYYYYMMDD(endDate);
        // --- AKHIR PERBAIKAN LOGIKA TANGGAL ---

        // (Sisa kode Anda untuk mengambil data dan membuat pivot tidak berubah)
        const [personel] = await pool.query(`SELECT DISTINCT p.id_personel, p.nama_lengkap, p.posisi_kerja_utama FROM personel p LEFT JOIN jadwal j ON p.id_personel = j.id_personel WHERE j.tanggal_jadwal BETWEEN ? AND ? ORDER BY p.posisi_kerja_utama, p.nama_lengkap`, [tanggalMulai, tanggalAkhir]);
        const [jadwalData] = await pool.query(`SELECT j.id_personel, j.tanggal_jadwal, s.nama_shift FROM jadwal j JOIN shift s ON j.id_shift = s.id_shift WHERE j.tanggal_jadwal BETWEEN ? AND ?`, [tanggalMulai, tanggalAkhir]);
        const [batasanData] = await pool.query(`SELECT id_personel, tanggal_mulai, tanggal_akhir, jenis_batasan FROM batasan_preferensi WHERE tanggal_mulai <= ? AND tanggal_akhir >= ?`, [tanggalAkhir, tanggalMulai]);
        
        const dates = [];
        for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
            dates.push(toYYYYMMDD(d));
        }

        const jadwalMap = new Map();
        jadwalData.forEach(j => jadwalMap.set(`${j.id_personel}-${toYYYYMMDD(j.tanggal_jadwal)}`, j.nama_shift));
        
        const batasanMap = new Map();
        batasanData.forEach(b => {
            for (let d = new Date(b.tanggal_mulai); d <= new Date(b.tanggal_akhir); d.setDate(d.getDate() + 1)) {
                batasanMap.set(`${b.id_personel}-${toYYYYMMDD(d)}`, b.jenis_batasan);
            }
        });
        
        const pivotData = {};
        personel.forEach(p => {
            const posisi = p.posisi_kerja_utama || 'Tanpa Posisi';
            if (!pivotData[posisi]) pivotData[posisi] = [];
            const jadwalPersonel = { nama_lengkap: p.nama_lengkap, jadwal: {} };
            dates.forEach(date => {
                const key = `${p.id_personel}-${date}`;
                jadwalPersonel.jadwal[date] = batasanMap.get(key) || jadwalMap.get(key) || null;
            });
            pivotData[posisi].push(jadwalPersonel);
        });

        const prevWeek = new Date(startDate); prevWeek.setDate(prevWeek.getDate() - 7);
        const nextWeek = new Date(startDate); nextWeek.setDate(nextWeek.getDate() + 7);

        const navLinks = {
            prev: `/view/${GUEST_SECRET_KEY}?start=${toYYYYMMDD(prevWeek)}`,
            next: `/view/${GUEST_SECRET_KEY}?start=${toYYYYMMDD(nextWeek)}`
        };

        res.render('guest_view', { pivotData, dates, navLinks });

    } catch (error) {
        console.error("Error fetching guest view data:", error);
        res.status(500).send("Server Error");
    }
});

// ===================================================
// ROUTES (RUTE HALAMAN)
// ===================================================

// Rute Halaman Utama (Dashboard Jadwal)

app.get('/login', redirectIfLoggedIn, (req, res) => {
    res.render('login', { title: 'Login', error: req.query.error });
});

app.get('/pengaturan', requireLogin, (req, res) => {
    res.render('pengaturan', { title: 'Pengaturan Akun' });
});
app.get('/setup-user', async (req, res) => {
    try {
        const username = 'Dimas';
        const password = 'password123'; // Ganti dengan password yang kuat
        const hashedPassword = await bcrypt.hash(password, 10);
        await pool.query("INSERT INTO users (username, password) VALUES (?, ?) ON DUPLICATE KEY UPDATE password=?", [username, hashedPassword, hashedPassword]);
        res.send(`User '${username}' dengan password '${password}' telah dibuat/diupdate. Hapus rute ini setelah selesai.`);
    } catch (error) {
        res.status(500).send('Gagal membuat user.');
    }
});
app.post('/api/user/update-password', requireLogin, async (req, res) => {
    const { password_lama, password_baru } = req.body;
    const userId = req.session.userId;

    if (!password_lama || !password_baru) {
        return res.status(400).json({ success: false, message: 'Semua kolom wajib diisi.' });
    }

    try {
        // 1. Ambil password user saat ini dari database
        const [[user]] = await pool.query("SELECT password FROM users WHERE id = ?", [userId]);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User tidak ditemukan.' });
        }

        // 2. Bandingkan password lama yang diinput dengan yang ada di database
        const isMatch = await bcrypt.compare(password_lama, user.password);
        if (!isMatch) {
            return res.status(401).json({ success: false, message: 'Password lama salah.' });
        }

        // 3. Jika cocok, hash password baru dan update ke database
        const hashedPassword = await bcrypt.hash(password_baru, 10);
        await pool.query("UPDATE users SET password = ? WHERE id = ?", [hashedPassword, userId]);

        res.json({ success: true, message: 'Password berhasil diperbarui!' });

    } catch (error) {
        console.error("Gagal update password:", error);
        res.status(500).json({ success: false, message: 'Terjadi kesalahan di server.' });
    }
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const [[user]] = await pool.query("SELECT * FROM users WHERE username = ?", [username]);
        if (!user) {
            // Username tidak ditemukan
            return res.render('login', { title: 'Login', error: 'Username tidak ditemukan' });
        }
        const passwordMatch = await bcrypt.compare(password, user.password);
        if (!passwordMatch) {
            // Password salah
            return res.render('login', { title: 'Login', error: 'Password anda salah' });
        }
        // Login sukses
        req.session.userId = user.id;
        req.session.user = { username: user.username };
        res.redirect('/');
    } catch (error) {
        console.error(error);
        res.render('login', { title: 'Login', error: 'Terjadi kesalahan di server' });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            return res.redirect('/');
        }
        res.clearCookie('connect.sid'); // Nama cookie default dari express-session
        res.redirect('/login');
    });
});


app.get("/", requireLogin, async (req, res) => {
  try {
    const queryPromise = async (sql, values) => {
  const [results] = await pool.query(sql, values);
  return results;
};

    // Jalankan semua query secara bersamaan, termasuk untuk analisis baru
    const [
      [totalPersonel],
      [totalPosisi],
      [totalShift],
      [onLeaveToday],
      tipePersonelData,
      posisiPersonelData,
      posisiKosongData, // DATA BARU
      personelSibukData, // DATA BARU
    ] = await Promise.all([
      queryPromise("SELECT COUNT(*) as total FROM personel"),
      queryPromise("SELECT COUNT(*) as total FROM posisi_kerja"),
      queryPromise("SELECT COUNT(*) as total FROM shift"),
      queryPromise(
        "SELECT COUNT(*) as total FROM batasan_preferensi WHERE CURDATE() BETWEEN tanggal_mulai AND tanggal_akhir"
      ),
      queryPromise(
  "SELECT tipe_personel, COUNT(*) as jumlah FROM personel WHERE tipe_personel IS NOT NULL AND tipe_personel != '' GROUP BY tipe_personel"
),
      queryPromise(
        "SELECT posisi_kerja_utama, COUNT(*) as jumlah FROM personel WHERE posisi_kerja_utama IS NOT NULL AND posisi_kerja_utama != '' GROUP BY posisi_kerja_utama ORDER BY jumlah DESC LIMIT 10"
      ),
      // Query baru yang hilang: 5 posisi paling sering kosong bulan ini
      queryPromise(`
                SELECT pos.nama_posisi, COUNT(*) as jumlah 
                FROM jadwal j
                JOIN posisi_kerja pos ON j.id_posisi = pos.id_posisi
                WHERE j.id_personel IS NULL AND MONTH(j.tanggal_jadwal) = MONTH(CURDATE()) AND YEAR(j.tanggal_jadwal) = YEAR(CURDATE())
                GROUP BY pos.nama_posisi ORDER BY jumlah DESC LIMIT 5
            `),
      // Query baru yang hilang: 5 personel dengan jadwal terbanyak bulan ini
      queryPromise(`
                SELECT p.nama_lengkap, COUNT(*) as jumlah
                FROM jadwal j
                JOIN personel p ON j.id_personel = p.id_personel
                WHERE j.id_personel IS NOT NULL AND MONTH(j.tanggal_jadwal) = MONTH(CURDATE()) AND YEAR(j.tanggal_jadwal) = YEAR(CURDATE())
                GROUP BY p.nama_lengkap ORDER BY jumlah DESC LIMIT 5
            `),
    ]);

    res.render("dashboard", {
      title: "Dashboard",
      stats: {
        personel: totalPersonel.total,
        posisi: totalPosisi.total,
        shift: totalShift.total,
        onLeave: onLeaveToday.total,
      },
      // Pastikan data baru dikirim ke halaman
      chartData: {
        tipePersonel: tipePersonelData,
        posisiPersonel: posisiPersonelData,
        posisiKosong: posisiKosongData,
        personelSibuk: personelSibukData,
      },
      currentPath: req.path
    });
  } catch (error) {
    console.error("Error fetching dashboard data:", error);
    res.status(500).send("Server Error");
  }
});

// RUTE BARU UNTUK HALAMAN JADWAL (menggantikan index.ejs yang lama)
const queryPromise = async (sql, values) => {
  const [results] = await pool.query(sql, values);
  return results;
};
// Di dalam app.js

app.get('/jadwal',requireLogin, async (req, res) => {
    try {
        const dataPerPage = 15;
        const currentPage = parseInt(req.query.page) || 1;
        const offset = (currentPage - 1) * dataPerPage;
        const { searchNama, filterPosisi, filterShift, filterTanggal } = req.query;

        let whereClauses = [];
        let queryParams = [];

        if (searchNama) { whereClauses.push("p.nama_lengkap LIKE ?"); queryParams.push(`%${searchNama}%`); }
        if (filterPosisi && filterPosisi !== '') { whereClauses.push("pos.id_posisi = ?"); queryParams.push(filterPosisi); }
        if (filterShift && filterShift !== '') { whereClauses.push("s.id_shift = ?"); queryParams.push(filterShift); }
        if (filterTanggal) { whereClauses.push("j.tanggal_jadwal = ?"); queryParams.push(filterTanggal); }

        const whereString = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

        const [
            [[{ total }]],
            [jadwal],
            [shifts],
            [posisi],
            [personel],
            [[dateRange]]
        ] = await Promise.all([
            pool.query(`SELECT COUNT(*) as total FROM jadwal j LEFT JOIN personel p ON j.id_personel = p.id_personel LEFT JOIN posisi_kerja pos ON j.id_posisi = pos.id_posisi LEFT JOIN shift s ON j.id_shift = s.id_shift ${whereString}`, queryParams),
            pool.query(`SELECT j.id_jadwal, j.tanggal_jadwal, s.nama_shift AS shift_terjadwal, p.nama_lengkap, pos.nama_posisi, j.status_jadwal FROM jadwal j LEFT JOIN personel p ON j.id_personel = p.id_personel LEFT JOIN posisi_kerja pos ON j.id_posisi = pos.id_posisi LEFT JOIN shift s ON j.id_shift = s.id_shift ${whereString} ORDER BY j.tanggal_jadwal DESC, s.nama_shift LIMIT ? OFFSET ?`, [...queryParams, dataPerPage, offset]),
            pool.query("SELECT * FROM shift ORDER BY nama_shift"),
            pool.query("SELECT * FROM posisi_kerja ORDER BY nama_posisi"),
            pool.query("SELECT id_personel, nama_lengkap FROM personel ORDER BY nama_lengkap"),
            pool.query("SELECT MIN(tanggal_jadwal) as minDate, MAX(tanggal_jadwal) as maxDate FROM jadwal")
        ]);

        // Konversi minDate dan maxDate ke string (yyyy-mm-dd) agar tidak error di EJS
        dateRange.minDate = dateRange.minDate ? dateRange.minDate.toISOString().slice(0, 10) : null;
        dateRange.maxDate = dateRange.maxDate ? dateRange.maxDate.toISOString().slice(0, 10) : null;

        const totalPages = Math.ceil(total / dataPerPage);

        res.render('jadwal', {
            title: 'Manajemen Jadwal',
            jadwal,
            shifts,
            posisi,
            personel,
            currentPage,
            totalPages,
            query: req.query,
            dateRange
        });

    } catch (error) {
        console.error("Error fetching schedule data:", error);
        res.status(500).send("Server Error");
    }
});
app.post("/api/jadwal/update-tanggal", requireLogin, async (req, res) => {
    const { id, tanggalBaru } = req.body;
    if (!id || !tanggalBaru) {
        return res.status(400).json({ success: false, message: "Data tidak lengkap." });
    }
    try {
        const [[jadwal]] = await pool.query("SELECT id_personel FROM jadwal WHERE id_jadwal = ?", [id]);
        if (jadwal && jadwal.id_personel) {
            const [konflik] = await pool.query("SELECT id_jadwal FROM jadwal WHERE id_personel = ? AND tanggal_jadwal = ? AND id_jadwal != ?", [jadwal.id_personel, tanggalBaru, id]);
            if (konflik.length > 0) {
                return res.status(409).json({ success: false, message: 'Gagal: Personel sudah punya jadwal lain di tanggal tujuan.' });
            }
        }
        await pool.query("UPDATE jadwal SET tanggal_jadwal = ?, status_jadwal = 'Manual Diedit' WHERE id_jadwal = ?", [tanggalBaru, id]);
        res.json({ success: true, message: "Jadwal berhasil diperbarui" });
    } catch (err) {
        res.status(500).json({ success: false, message: "Gagal update jadwal di server." });
    }
});

// API untuk MENGHAPUS jadwal berdasarkan ID
app.delete("/api/jadwal/delete/:id", requireLogin, async (req, res) => {
    try {
        const jadwalId = req.params.id;
        const [result] = await pool.query("DELETE FROM jadwal WHERE id_jadwal = ?", [jadwalId]);
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: "Jadwal tidak ditemukan" });
        // Tambahkan logging admin
        await logAdminAction(req, 'DELETE', 'jadwal', jadwalId, `Hapus jadwal id: ${jadwalId}`);
        res.json({ success: true, message: "Jadwal berhasil dihapus" });
    } catch (err) {
        res.status(500).json({ success: false, message: "Gagal menghapus jadwal" });
    }
});
// Rute Halaman Manajemen Personel
app.get("/personel",requireLogin, async (req, res) => {
  try {
    const dataPerPage = 20;
    const currentPage = parseInt(req.query.page) || 1;
    const offset = (currentPage - 1) * dataPerPage;

    // Ambil semua parameter filter dari query URL
    const { searchNama, filterTipe, filterPosisi, filterShift } = req.query;

    // Bangun query WHERE secara dinamis
    let whereClauses = [];
    let queryParams = [];

    if (searchNama) {
      whereClauses.push("p.nama_lengkap LIKE ?");
      queryParams.push(`%${searchNama}%`);
    }
    if (filterTipe && filterTipe !== "semua") {
      whereClauses.push("p.tipe_personel = ?");
      queryParams.push(filterTipe);
    }
    if (filterPosisi && filterPosisi !== "semua") {
      whereClauses.push("p.posisi_kerja_utama = ?");
      queryParams.push(filterPosisi);
    }
    if (filterShift && filterShift !== "semua") {
      if (filterShift === "N/A") {
        whereClauses.push("s.nama_shift IS NULL");
      } else {
        whereClauses.push("s.nama_shift = ?");
        queryParams.push(filterShift);
      }
    }

    const whereString =
      whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    // Helper untuk promise-based query
    const queryPromise = async (sql, values) => {
  const [results] = await pool.query(sql, values);
  return results;
};

    // Query untuk menghitung total data SETELAH difilter
    const countQuery = `SELECT COUNT(*) AS total FROM personel p LEFT JOIN shift s ON p.id_shift_standar = s.id_shift ${whereString}`;
    const totalResult = await queryPromise(countQuery, queryParams);
    const totalData = totalResult[0].total;
    const totalPages = Math.ceil(totalData / dataPerPage);

    // Query untuk mengambil data personel SETELAH difilter dan dipaginasi
    const personelQuery = `
            SELECT p.*, s.nama_shift 
            FROM personel p 
            LEFT JOIN shift s ON p.id_shift_standar = s.id_shift 
            ${whereString}
            ORDER BY p.nama_lengkap
            LIMIT ? OFFSET ?
        `;

    const personel = await queryPromise(personelQuery, [
      ...queryParams,
      dataPerPage,
      offset,
    ]);

    // Ambil data master untuk mengisi dropdown filter
    const [posisi, shifts] = await Promise.all([
      queryPromise("SELECT * FROM posisi_kerja ORDER BY nama_posisi"),
      queryPromise("SELECT * FROM shift ORDER BY nama_shift"),
    ]);

    res.render("personel", {
      title: "Manajemen Personel",
      personel: personel,
      posisi: posisi,
      shifts: shifts,
      currentPage: currentPage,
      totalPages: totalPages,
      // Kirim kembali nilai filter agar form tetap terisi
      query: req.query,
    });
  } catch (error) {
    console.error("Error fetching personel data:", error);
    res.status(500).send("Server Error");
  }
});

// Rute untuk menampilkan halaman edit personel
app.get("/personel/edit/:id", requireLogin, async (req, res) => {
  const personelId = req.params.id;
  const personelQuery = "SELECT * FROM personel WHERE id_personel = ?";
  const posisiQuery = "SELECT * FROM posisi_kerja ORDER BY nama_posisi";
  const shiftQuery = "SELECT * FROM shift ORDER BY nama_shift";

  try {
    const [[personelResult], posisiResult, shiftsResult] = await Promise.all([
      pool.query(personelQuery, [personelId]),
      pool.query(posisiQuery),
      pool.query(shiftQuery),
    ]);

    if (!personelResult) {
      return res.redirect("/personel");
    }

    res.render("edit_personel", {
      title: "Edit Personel",
      personel: personelResult,
      posisi: posisiResult[0],
      shifts: shiftsResult[0],
    });
  } catch (err) {
    console.error(err);
    res.redirect("/personel");
  }
});

// Rute untuk PROSES UPDATE data personel
app.post("/personel/update/:id", requireLogin, async (req, res) => {
    try {
        const personelId = req.params.id;
        const { nama_lengkap, tipe_personel, posisi_kerja_utama, id_shift_standar, kontak_telepon, email } = req.body;
        const shiftValue = id_shift_standar ? parseInt(id_shift_standar, 10) : null;
        const query = `
            UPDATE personel 
            SET nama_lengkap = ?, tipe_personel = ?, posisi_kerja_utama = ?, 
                id_shift_standar = ?, kontak_telepon = ?, email = ? 
            WHERE id_personel = ?
        `;
        const values = [nama_lengkap, tipe_personel, posisi_kerja_utama, shiftValue, kontak_telepon, email, personelId];
        await pool.query(query, values);
        // Logging aktivitas admin
        await logAdminAction(req, 'UPDATE', 'personel', personelId, `Edit personel: ${nama_lengkap}`);
        res.json({ success: true, message: 'Data personel berhasil diperbarui.' });
    } catch (error) {
        console.error("Error updating personel:", error);
        res.status(500).json({ success: false, message: 'Gagal memperbarui data di server.' });
    }
});

// Rute untuk PROSES HAPUS personel
app.post("/personel/hapus/:id", requireLogin, async (req, res) => {
    try {
        const personelId = req.params.id;
        // Ambil nama personel untuk log (opsional)
        const [[personel]] = await pool.query("SELECT nama_lengkap FROM personel WHERE id_personel = ?", [personelId]);
        await pool.query("DELETE FROM personel WHERE id_personel = ?", [personelId]);
        // Logging aktivitas admin
        await logAdminAction(req, 'DELETE', 'personel', personelId, `Hapus personel: ${personel ? personel.nama_lengkap : ''}`);

        // Ambil parameter filter & page dari query agar redirect tetap di halaman & filter yang sama
        const page = req.query.page ? `&page=${req.query.page}` : '';
        const searchNama = req.query.searchNama ? `&searchNama=${encodeURIComponent(req.query.searchNama)}` : '';
        const filterTipe = req.query.filterTipe ? `&filterTipe=${encodeURIComponent(req.query.filterTipe)}` : '';
        const filterPosisi = req.query.filterPosisi ? `&filterPosisi=${encodeURIComponent(req.query.filterPosisi)}` : '';
        const filterShift = req.query.filterShift ? `&filterShift=${encodeURIComponent(req.query.filterShift)}` : '';

        res.redirect(`/personel?status=hapus_sukses${page}${searchNama}${filterTipe}${filterPosisi}${filterShift}`);
    } catch (error) {
        console.error(error);

        const page = req.query.page ? `&page=${req.query.page}` : '';
        const searchNama = req.query.searchNama ? `&searchNama=${encodeURIComponent(req.query.searchNama)}` : '';
        const filterTipe = req.query.filterTipe ? `&filterTipe=${encodeURIComponent(req.query.filterTipe)}` : '';
        const filterPosisi = req.query.filterPosisi ? `&filterPosisi=${encodeURIComponent(req.query.filterPosisi)}` : '';
        const filterShift = req.query.filterShift ? `&filterShift=${encodeURIComponent(req.query.filterShift)}` : '';

        res.redirect(`/personel?status=gagal${page}${searchNama}${filterTipe}${filterPosisi}${filterShift}`);
    }
});

// Rute untuk PROSES MENAMBAH personel baru (dari form)
app.post("/personel/tambah", requireLogin, async (req, res) => {
    try {
        const { nama_lengkap, tipe_personel, posisi_kerja_utama, id_shift_standar } = req.body;
        const shiftValue = id_shift_standar ? parseInt(id_shift_standar) : null;
        const query = `INSERT INTO personel (nama_lengkap, tipe_personel, posisi_kerja_utama, id_shift_standar) VALUES (?, ?, ?, ?)`;
        const [result] = await pool.query(query, [nama_lengkap, tipe_personel, posisi_kerja_utama, shiftValue]);
        // Logging aktivitas admin
        await logAdminAction(req, 'CREATE', 'personel', result.insertId, `Tambah personel: ${nama_lengkap}`);
        res.redirect('/personel?status=tambah_sukses');
    } catch (error) {
        console.error(error);
        res.redirect('/personel?status=gagal');
    }
});

// Rute untuk menampilkan halaman manajemen batasan
app.get('/batasan', requireLogin, async (req, res) => {
    try {
        const dataPerPage = 10;
        const currentPage = parseInt(req.query.page) || 1;
        const offset = (currentPage - 1) * dataPerPage;
        const { searchNama, filterJenis } = req.query;

        let whereClauses = [];
        let queryParams = [];

        if (searchNama) {
            whereClauses.push("p.nama_lengkap LIKE ?");
            queryParams.push(`%${searchNama}%`);
        }
        if (filterJenis) {
            whereClauses.push("b.jenis_batasan = ?");
            queryParams.push(filterJenis);
        }

        const whereString = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

        const countQuery = `SELECT COUNT(*) as total FROM batasan_preferensi b JOIN personel p ON b.id_personel = p.id_personel ${whereString}`;
        const [[{ total }]] = await pool.query(countQuery, queryParams);
        const totalPages = Math.ceil(total / dataPerPage);

        const batasanQuery = `
            SELECT b.id_batasan, p.nama_lengkap, b.tanggal_mulai, b.tanggal_akhir, b.jenis_batasan, b.keterangan 
            FROM batasan_preferensi b
            JOIN personel p ON b.id_personel = p.id_personel
            ${whereString}
            ORDER BY b.tanggal_mulai DESC
            LIMIT ? OFFSET ?`;
        
        const [batasan] = await pool.query(batasanQuery, [...queryParams, dataPerPage, offset]);
        const [personel] = await pool.query("SELECT id_personel, nama_lengkap FROM personel ORDER BY nama_lengkap");

        res.render('batasan', {
            title: 'Manajemen Batasan',
            batasan,
            personel,
            currentPage,
            totalPages,
            query: req.query,
            currentPath: req.path
        });
    } catch (error) {
        console.error("Error fetching batasan data:", error);
        res.status(500).send("Server Error");
    }
});

// Ganti rute POST /batasan/tambah yang lama
// Ganti rute POST /batasan/tambah yang lama
app.post("/batasan/tambah",requireLogin, async (req, res) => {
    try {
        const { id_personel, jenis_batasan, tanggal_mulai, tanggal_akhir, keterangan } = req.body;
        if (!id_personel || !jenis_batasan || !tanggal_mulai || !tanggal_akhir) {
            return res.status(400).json({ success: false, message: 'Semua kolom wajib diisi.' });
        }

        // Hitung durasi pengajuan
        const startDate = new Date(tanggal_mulai);
        const endDate = new Date(tanggal_akhir);
        const duration = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1;

        // Jika jenisnya BUKAN cuti, langsung simpan
        if (jenis_batasan !== 'Cuti') {
            await pool.query("INSERT INTO batasan_preferensi (id_personel, jenis_batasan, tanggal_mulai, tanggal_akhir, keterangan) VALUES (?, ?, ?, ?, ?)", [id_personel, jenis_batasan, tanggal_mulai, tanggal_akhir, keterangan]);
            return res.json({ success: true, message: `Batasan '${jenis_batasan}' berhasil ditambahkan!` });
        }

        // --- Logika Khusus untuk Cuti ---
        // 1. Ambil data cuti personel
        const [[personel]] = await pool.query("SELECT jatah_cuti, cuti_terpakai FROM personel WHERE id_personel = ?", [id_personel]);
        const sisaCuti = personel.jatah_cuti - personel.cuti_terpakai;

        // 2. Validasi jatah cuti
        if (duration > sisaCuti) {
            return res.status(400).json({ success: false, message: `Gagal, jatah cuti tidak mencukupi. Sisa cuti: ${sisaCuti} hari.` });
        }

        // 3. Simpan batasan cuti
        const [insertResult] = await pool.query("INSERT INTO batasan_preferensi (id_personel, jenis_batasan, tanggal_mulai, tanggal_akhir, keterangan) VALUES (?, ?, ?, ?, ?)", [id_personel, 'Cuti', tanggal_mulai, tanggal_akhir, keterangan]);

        // 4. Update cuti terpakai di tabel personel
        if (insertResult.affectedRows > 0) {
            await pool.query("UPDATE personel SET cuti_terpakai = cuti_terpakai + ? WHERE id_personel = ?", [duration, id_personel]);
            await logAdminAction(req, 'CREATE', 'batasan_preferensi', insertResult.insertId, `Tambah cuti: ${duration} hari untuk personel ${id_personel} (${tanggal_mulai} s/d ${tanggal_akhir})`);
        }
        
        res.json({ success: true, message: `Cuti selama ${duration} hari berhasil ditambahkan!` });

    } catch (error) {
        console.error("Gagal menambah batasan:", error);
        res.status(500).json({ success: false, message: 'Terjadi kesalahan di server.' });
    }
});

// Ganti rute POST /batasan/hapus/:id yang lama
app.post("/batasan/hapus/:id", requireLogin, async (req, res) => {
    try {
        const id_batasan = req.params.id;
        // Logika sekarang hanya menghapus entri batasan, tidak ada pengembalian jatah cuti.
        await pool.query("DELETE FROM batasan_preferensi WHERE id_batasan = ?", [id_batasan]);
        await logAdminAction(req, 'DELETE', 'batasan_preferensi', id_batasan, `Hapus batasan id: ${id_batasan}`);
        
        res.redirect('/batasan?status=hapus_sukses');
    } catch (error) {
        console.error("Gagal menghapus batasan:", error);
        res.redirect('/batasan?status=gagal');
    }
});

// Ganti seluruh rute POST /generate-jadwal yang lama dengan versi ini
app.post("/generate-jadwal", requireLogin, async (req, res) => {
    try {
        const { tanggalMulai, tanggalAkhir, kecualikan } = req.body;
        const excludedIds = (kecualikan || []).map(Number); 

        if (!tanggalMulai || !tanggalAkhir) {
            return res.status(400).send("Tanggal Mulai dan Tanggal Akhir harus diisi.");
        }

        // 1. Ambil semua data yang diperlukan secara bersamaan
        const [
            [allPersonel], [shifts], [posisiKerja], [batasan]
        ] = await Promise.all([
            pool.query("SELECT p.id_personel, p.posisi_kerja_utama, pk.hari_kerja FROM personel p JOIN posisi_kerja pk ON p.posisi_kerja_utama = pk.nama_posisi"),
            pool.query("SELECT id_shift, kuota, hari_kerja FROM shift"),
            pool.query("SELECT id_posisi, nama_posisi FROM posisi_kerja"),
            pool.query("SELECT id_personel, tanggal_mulai, tanggal_akhir FROM batasan_preferensi WHERE tanggal_mulai <= ? AND tanggal_akhir >= ?", [tanggalAkhir, tanggalMulai])
        ]);

        if (allPersonel.length === 0 || shifts.length === 0) {
            return res.status(400).send("Tidak ada data personel atau shift untuk membuat jadwal.");
        }

        // 2. Filter personel yang dikecualikan
        const personelToSchedule = allPersonel.filter(p => !excludedIds.includes(p.id_personel));
        
        // 3. Buat 'peta' batasan untuk pencarian cepat
        const batasanLookup = new Set();
        batasan.forEach(b => {
            let currentDate = new Date(b.tanggal_mulai);
            const endDate = new Date(b.tanggal_akhir);
            while (currentDate <= endDate) {
                const dateString = toYYYYMMDD(currentDate);
                batasanLookup.add(`${b.id_personel}-${dateString}`);
                currentDate.setDate(currentDate.getDate() + 1);
            }
        });

        const posisiNameToIdMap = new Map(posisiKerja.map(p => [p.nama_posisi, p.id_posisi]));
        
        // 4. Hapus jadwal lama dalam rentang yang dipilih
        await pool.query("DELETE FROM jadwal WHERE tanggal_jadwal BETWEEN ? AND ?", [tanggalMulai, tanggalAkhir]);

        // 5. Looping setiap hari untuk membuat jadwal
        for (let loopDate = new Date(tanggalMulai); loopDate <= new Date(tanggalAkhir); loopDate.setDate(loopDate.getDate() + 1)) {
            const tanggalSQL = toYYYYMMDD(loopDate);
            const dayOfWeek = loopDate.getDay(); // 0=Minggu, 1=Senin, ...
            
            // Peta untuk melacak kuota shift yang sudah terpakai HARI INI
            const shiftUsageToday = new Map(); 
            
            // Filter shift yang aktif pada hari ini
            const shiftsAktifHariIni = shifts.filter(s => s.hari_kerja.split(',').includes(String(dayOfWeek)));
            if (shiftsAktifHariIni.length === 0) continue; // Lanjut ke hari berikutnya jika tidak ada shift

            // Acak urutan personel agar penempatan lebih adil
            const shuffledPersonel = personelToSchedule.sort(() => 0.5 - Math.random());

            for (const p of shuffledPersonel) {
                // Lewati jika personel punya batasan atau tidak bekerja di hari ini
                if (batasanLookup.has(`${p.id_personel}-${tanggalSQL}`)) continue;
                if (!p.hari_kerja || !p.hari_kerja.split(',').includes(String(dayOfWeek))) continue;
                
                // Lewati jika posisi kerja utama tidak valid
                if (!p.posisi_kerja_utama || !posisiNameToIdMap.has(p.posisi_kerja_utama)) continue;

                // Cari shift yang kuotanya masih tersedia
                const availableShifts = shiftsAktifHariIni.filter(s => (shiftUsageToday.get(s.id_shift) || 0) < s.kuota);
                
                if (availableShifts.length > 0) {
                    const randomShift = availableShifts[Math.floor(Math.random() * availableShifts.length)];
                    const idPosisi = posisiNameToIdMap.get(p.posisi_kerja_utama);
                    
                    await pool.query("INSERT INTO jadwal (tanggal_jadwal, id_personel, id_posisi, id_shift, status_jadwal) VALUES (?, ?, ?, ?, 'Otomatis')", [tanggalSQL, p.id_personel, idPosisi, randomShift.id_shift]);
                    
                    // Update Peta Penggunaan Shift untuk hari ini
                    shiftUsageToday.set(randomShift.id_shift, (shiftUsageToday.get(randomShift.id_shift) || 0) + 1);
                }
            }
        }
        
        res.redirect("/jadwal?status=success&tab=tabel");
    } catch (error) {
        console.error("Error saat generate jadwal acak:", error);
        res.status(500).send("Terjadi error pada server saat membuat jadwal.");
    }
});

// Rute untuk menampilkan halaman edit jadwal manual
app.get("/jadwal/edit/:id", requireLogin, async (req, res) => {
  const jadwalId = req.params.id;

  // Helper untuk promise-based query
  const queryPromise = async (sql, values) => {
  const [results] = await pool.query(sql, values);
  return results;
};

  try {
    const jadwalQuery = `
            SELECT j.id_jadwal, j.tanggal_jadwal, j.id_personel, j.id_posisi, j.id_shift, 
                   pos.nama_posisi, s.nama_shift
            FROM jadwal j
            LEFT JOIN posisi_kerja pos ON j.id_posisi = pos.id_posisi
            LEFT JOIN shift s ON j.id_shift = s.id_shift
            WHERE j.id_jadwal = ?`;

    // Ambil semua data yang diperlukan secara bersamaan
    const [jadwalResult, personel, posisi, shifts] = await Promise.all([
      queryPromise(jadwalQuery, [jadwalId]),
      queryPromise(
        "SELECT id_personel, nama_lengkap, posisi_kerja_utama FROM personel ORDER BY nama_lengkap"
      ),
      queryPromise("SELECT * FROM posisi_kerja ORDER BY nama_posisi"),
      queryPromise("SELECT * FROM shift ORDER BY nama_shift"),
    ]);

    if (jadwalResult.length === 0) {
      return res.redirect("/");
    }

    res.render("edit_jadwal", {
      title: "Edit Jadwal Manual",
      jadwal: jadwalResult[0],
      personel: personel,
      posisi: posisi,
      shifts: shifts,
    });
  } catch (error) {
    console.error("Error fetching data for schedule edit:", error);
    res.redirect("/");
  }
});

app.get('/api/jadwal/date-range',requireLogin,  async (req, res) => {
    try {
        const [[dateRange]] = await pool.query("SELECT MIN(tanggal_jadwal) as minDate, MAX(tanggal_jadwal) as maxDate FROM jadwal");
        res.json(dateRange);
    } catch (error) {
        console.error("Gagal mengambil rentang tanggal:", error);
        res.status(500).json({ message: "Gagal mengambil rentang tanggal." });
    }
});

// Rute untuk PROSES UPDATE jadwal manual dari modal
app.post('/jadwal/update/:id', requireLogin, async (req, res) => {
    try {
        const { tanggal_jadwal, id_posisi, id_shift, id_personel } = req.body;
        const id_jadwal = req.params.id;

        // Jika id_shift kosong string, set ke null
        const shiftValue = id_shift === '' ? null : id_shift;
        const personelValue = id_personel === '' ? null : id_personel;

        // VALIDASI: Cek apakah personel sudah punya jadwal di tanggal yang sama (kecuali id ini)
        if (personelValue) {
            const [bentrok] = await pool.query(
                "SELECT id_jadwal FROM jadwal WHERE tanggal_jadwal = ? AND id_personel = ? AND id_jadwal != ?",
                [tanggal_jadwal, personelValue, id_jadwal]
            );
            if (bentrok.length > 0) {
                return res.status(400).json({ success: false, message: "Personel ini sudah punya jadwal di tanggal tersebut!" });
            }
        }

        await pool.query(
            `UPDATE jadwal SET 
                tanggal_jadwal = ?, 
                id_posisi = ?, 
                id_shift = ?, 
                id_personel = ?,
                status_jadwal = 'Manual Diedit'
            WHERE id_jadwal = ?`,
            [tanggal_jadwal, id_posisi, shiftValue, personelValue, id_jadwal]
        );
        await logAdminAction(req, 'UPDATE', 'jadwal', id_jadwal, `Edit jadwal manual, personel: ${id_personel}, tanggal: ${tanggal_jadwal}`);
        res.json({ success: true, message: "Jadwal berhasil diperbarui" });
    } catch (error) {
        res.status(500).json({ success: false, message: "Gagal update jadwal" });
    }
});


app.post('/jadwal/hapus/:id',requireLogin, async (req, res) => {
    try {
        const jadwalId = req.params.id;
        await pool.query("DELETE FROM jadwal WHERE id_jadwal = ?", [jadwalId]);
        
        await logAdminAction(req, 'DELETE', 'jadwal', jadwalId, `Hapus jadwal id: ${jadwalId}`);
        res.redirect('/jadwal?status=hapus_sukses&tab=tabel');
    } catch (error) {
        console.error("Gagal menghapus jadwal:", error);
        res.redirect('/jadwal?status=gagal&tab=tabel');
    }
});

app.post('/jadwal/hapus-rentang',requireLogin, async (req, res) => {
    try {
        const { tanggalMulaiHapus, tanggalAkhirHapus } = req.body;

        if (!tanggalMulaiHapus || !tanggalAkhirHapus) {
            return res.status(400).send("Harap tentukan tanggal mulai dan tanggal akhir.");
        }

        const [result] = await pool.query(
            "DELETE FROM jadwal WHERE tanggal_jadwal BETWEEN ? AND ?",
            [tanggalMulaiHapus, tanggalAkhirHapus]
        );
        
await logAdminAction(req, 'DELETE', 'jadwal', null, `Hapus jadwal rentang: ${tanggalMulaiHapus} s/d ${tanggalAkhirHapus}, total: ${result.affectedRows}`);
        res.redirect(`/jadwal?status=hapus_rentang_sukses&jumlah=${result.affectedRows}&tab=tabel`);

    } catch (error) {
        console.error("Gagal menghapus jadwal berdasarkan rentang:", error);
        res.redirect('/jadwal?status=gagal&tab=tabel');
    }
});

// Rute untuk menampilkan halaman manajemen shift
app.get('/shift', requireLogin, async (req, res) => {
    try {
        const dataPerPage = 8;
        const currentPage = parseInt(req.query.page) || 1;
        const offset = (currentPage - 1) * dataPerPage;
        const { search } = req.query;

        let whereClause = '';
        let queryParams = [];

        if (search) {
            whereClause = 'WHERE nama_shift LIKE ?';
            queryParams.push(`%${search}%`);
        }

        const countQuery = `SELECT COUNT(*) as total FROM shift ${whereClause}`;
        const [[{ total }]] = await pool.query(countQuery, queryParams);
        const totalPages = Math.ceil(total / dataPerPage);

        // PERBAIKAN: Tambahkan 'hari_kerja' ke dalam SELECT
        const shiftsQuery = `SELECT id_shift, nama_shift, kuota, hari_kerja FROM shift ${whereClause} ORDER BY id_shift DESC LIMIT ? OFFSET ?`;
        const [shifts] = await pool.query(shiftsQuery, [...queryParams, dataPerPage, offset]);

        res.render('shift', {
            title: 'Manajemen Shift',
            shifts,
            currentPage,
            totalPages,
            query: req.query,
        });
    } catch (error) {
        console.error("Error fetching shift data:", error);
        res.status(500).send("Server Error");
    }
});


// TAMBAHKAN DUA RUTE API BARU INI
// API untuk mendapatkan satu shift (untuk edit modal)
app.get('/api/shift/:id', requireLogin, async (req, res) => {
    try {
        const [rows] = await pool.query("SELECT id_shift, nama_shift, kuota, hari_kerja FROM shift WHERE id_shift = ?", [req.params.id]);
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Shift tidak ditemukan' });
        }
        
        // PERBAIKAN: Ubah string "1,2,3" menjadi array ['1','2','3']
        const shiftData = rows[0];
        shiftData.hari_kerja = shiftData.hari_kerja.split(',');

        res.json(shiftData);
    } catch (error) {
        res.status(500).json({ message: 'Server error' });
    }
});

// API untuk mengupdate shift
app.post('/api/shift/update/:id', requireLogin, async (req, res) => {
    try {
        const { nama_shift, kuota, hari_kerja } = req.body;
        
        if (!nama_shift || !kuota || !hari_kerja || hari_kerja.length === 0) {
            return res.status(400).json({ success: false, message: 'Nama shift, kuota, dan hari kerja tidak boleh kosong.' });
        }

        // PERBAIKAN: Gabungkan array hari kerja menjadi string
        const hariKerjaString = hari_kerja.join(',');

        await pool.query(
            "UPDATE shift SET nama_shift = ?, kuota = ?, hari_kerja = ? WHERE id_shift = ?", 
            [nama_shift, kuota, hariKerjaString, req.params.id]
        );

        // Tambahkan log admin di sini
        await logAdminAction(req, 'UPDATE', 'shift', req.params.id, `Edit shift: ${nama_shift}, kuota: ${kuota}, hari_kerja: ${hariKerjaString}`);

        res.json({ success: true, message: 'Shift berhasil diperbarui' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Gagal memperbarui shift' });
    }
});

// Ganti rute POST /shift/tambah
app.post("/api/shift/tambah", requireLogin, async (req, res) => {
    try {
        const { nama_shift, kuota, hari_kerja } = req.body;

        if (!nama_shift || !kuota || !hari_kerja || hari_kerja.length === 0 || nama_shift.trim() === '' || kuota < 1) {
            return res.status(400).json({ success: false, message: 'Nama shift, kuota, dan hari kerja wajib diisi.' });
        }
        
        // Cek duplikat
        const [[{ count }]] = await pool.query("SELECT COUNT(*) as count FROM shift WHERE nama_shift = ?", [nama_shift.trim()]);
        if (count > 0) {
            return res.status(409).json({ success: false, message: 'Nama shift sudah tersedia.' });
        }

        // Gabungkan array hari kerja menjadi string
        const hariKerjaString = hari_kerja.join(',');

        const [result] = await pool.query("INSERT INTO shift (nama_shift, kuota, hari_kerja) VALUES (?, ?, ?)", [nama_shift.trim(), kuota, hariKerjaString]);
        
        // Tambahkan log admin di sini
        await logAdminAction(req, 'CREATE', 'shift', result.insertId, `Tambah shift: ${nama_shift}, kuota: ${kuota}, hari_kerja: ${hariKerjaString}`);

        res.json({ success: true, message: 'Shift baru berhasil ditambahkan!' });
    } catch (error) {
        console.error("Gagal menambah shift:", error);
        res.status(500).json({ success: false, message: 'Terjadi kesalahan di server.' });
    }
});

// Ganti rute POST /shift/hapus/:id
// Di dalam app.js

app.post("/shift/hapus/:id", requireLogin, async (req, res) => {
    try {
        const shiftId = req.params.id;
        const page = req.query.page ? `&page=${req.query.page}` : '';
        const search = req.query.search ? `&search=${encodeURIComponent(req.query.search)}` : '';
        await pool.query("DELETE FROM shift WHERE id_shift = ?", [shiftId]);
        // Tambahkan log admin di sini
        await logAdminAction(req, 'DELETE', 'shift', shiftId, `Hapus shift id: ${shiftId}`);
        res.redirect(`/shift?status=hapus_sukses${page}${search}`);
    } catch (error) {
        let msg = 'Gagal menghapus shift.';
        if (error && error.code === 'ER_ROW_IS_REFERENCED_2') {
            msg = 'Shift tidak bisa dihapus karena masih digunakan pada jadwal.';
        }
        const page = req.query.page ? `&page=${req.query.page}` : '';
        const search = req.query.search ? `&search=${encodeURIComponent(req.query.search)}` : '';
        res.redirect(`/shift?status=gagal_hapus&pesan=${encodeURIComponent(msg)}${page}${search}`);
    }
});
// Rute untuk menampilkan halaman manajemen posisi kerja
app.get('/posisi',requireLogin, async (req, res) => {
    try {
        const dataPerPage = 8;
        const currentPage = parseInt(req.query.page) || 1;
        const offset = (currentPage - 1) * dataPerPage;
        const { search } = req.query;

        let whereClause = '';
        let queryParams = [];

        if (search) {
            whereClause = 'WHERE nama_posisi LIKE ?';
            queryParams.push(`%${search}%`);
        }

        const countQuery = `SELECT COUNT(*) as total FROM posisi_kerja ${whereClause}`;
        const [[{ total }]] = await pool.query(countQuery, queryParams);
        const totalPages = Math.ceil(total / dataPerPage);

        const posisiQuery = `SELECT * FROM posisi_kerja ${whereClause} ORDER BY id_posisi DESC LIMIT ? OFFSET ?`;
        const [posisi] = await pool.query(posisiQuery, [...queryParams, dataPerPage, offset]);

        res.render('posisi', {
            title: 'Manajemen Posisi',
            posisi,
            currentPage,
            totalPages,
            query: req.query,
            currentPath: req.path
        });
    } catch (error) {
        console.error("Error fetching posisi data:", error);
        res.status(500).send("Server Error");
    }
});

// API untuk mendapatkan satu posisi (untuk edit modal)
app.get('/api/posisi/:id', async (req, res) => {
    const [rows] = await pool.query("SELECT id_posisi, nama_posisi, hari_kerja FROM posisi_kerja WHERE id_posisi = ?", [req.params.id]);
    // Ubah string "1,2,3" menjadi array ['1','2','3']
    if (rows.length > 0) {
        rows[0].hari_kerja = rows[0].hari_kerja.split(',');
    }
    res.json(rows[0]);
});

// API untuk mengupdate posisi

app.post('/api/posisi/update/:id', requireLogin, async (req, res) => {
    const { nama_posisi, hari_kerja } = req.body;
    const hariKerjaString = hari_kerja.join(',');
    await pool.query("UPDATE posisi_kerja SET nama_posisi = ?, hari_kerja = ? WHERE id_posisi = ?", [nama_posisi, hariKerjaString, req.params.id]);
    await logAdminAction(req, 'UPDATE', 'posisi_kerja', req.params.id, `Edit posisi: ${nama_posisi}`);
    res.json({ success: true, message: 'Posisi berhasil diperbarui' });
});


// Rute untuk PROSES MENAMBAH posisi kerja baru
app.post("/api/posisi/tambah", requireLogin, async (req, res) => {
    try {
        const { nama_posisi, hari_kerja } = req.body;

        // Validasi 1: Pastikan input tidak kosong
        if (!nama_posisi || !hari_kerja || hari_kerja.length === 0 || nama_posisi.trim() === '') {
            return res.status(400).json({ success: false, message: 'Nama posisi dan hari kerja wajib diisi.' });
        }

        // Validasi 2: Cek duplikat nama posisi
        const checkQuery = "SELECT COUNT(*) as count FROM posisi_kerja WHERE nama_posisi = ?";
        const [[{ count }]] = await pool.query(checkQuery, [nama_posisi.trim()]);

        if (count > 0) {
            return res.status(409).json({ 
                success: false, 
                message: 'Posisi sudah tersedia, silakan masukan posisi yang lain.' 
            });
        }
        
        // Ubah array hari kerja (e.g., ['1','2','5']) menjadi string "1,2,5"
        const hariKerjaString = hari_kerja.join(',');

        // Jika tidak ada duplikat, lanjutkan proses INSERT
        const [result] = await pool.query(
            "INSERT INTO posisi_kerja (nama_posisi, hari_kerja) VALUES (?, ?)", 
            [nama_posisi.trim(), hariKerjaString]
        );

        // Tambahkan log admin di sini
        await logAdminAction(req, 'CREATE', 'posisi_kerja', result.insertId, `Tambah posisi: ${nama_posisi}, hari_kerja: ${hariKerjaString}`);

        res.json({ success: true, message: 'Posisi baru berhasil ditambahkan!' });

    } catch (error) {
        console.error("Gagal menambah posisi:", error);
        res.status(500).json({ success: false, message: 'Terjadi kesalahan di server.' });
    }
});


// Rute untuk PROSES HAPUS posisi kerja
app.post("/posisi/hapus/:id", requireLogin, async (req, res) => {
    try {
        const idPosisi = req.params.id;
        const page = req.query.page ? `&page=${req.query.page}` : '';
        const search = req.query.search ? `&search=${encodeURIComponent(req.query.search)}` : '';
        // Cek apakah posisi masih digunakan di jadwal
        const [[{ count }]] = await pool.query(
            "SELECT COUNT(*) as count FROM jadwal WHERE id_posisi = ?", [idPosisi]
        );
        if (count > 0) {
            // Jika masih dipakai, redirect dengan pesan error
            return res.redirect(`/posisi?status=gagal_hapus&pesan=${encodeURIComponent('Posisi tidak bisa dihapus karena masih digunakan pada jadwal.')}${page}${search}`);
        }
        await pool.query("DELETE FROM posisi_kerja WHERE id_posisi = ?", [idPosisi]);
        await logAdminAction(req, 'DELETE', 'posisi_kerja', idPosisi, `Hapus posisi id: ${idPosisi}`);
        res.redirect(`/posisi?status=hapus_sukses${page}${search}`);
    } catch (error) {
        console.error(error);
        const page = req.query.page ? `&page=${req.query.page}` : '';
        const search = req.query.search ? `&search=${encodeURIComponent(req.query.search)}` : '';
        res.redirect(`/posisi?status=gagal_hapus&pesan=${encodeURIComponent('Gagal menghapus posisi.')}${page}${search}`);
    }
});

// Rute untuk MENAMPILKAN halaman tambah banyak personel
app.get("/personel/tambah-bulk", requireLogin, async (req, res) => {
  try {
    await pool.query(
      "SELECT * FROM posisi_kerja ORDER BY nama_posisi",
      (err, posisi) => {
        if (err) throw err;
        res.render("tambah_bulk", {
          title: "Tambah Banyak Personel",
          posisi: posisi,
        });
      }
    );
  } catch (error) {
    console.error(error);
    res.redirect("/personel");
  }
});

// Rute untuk MEMPROSES form "Posisi Sama"
app.post("/personel/tambah-bulk-sama",requireLogin, async (req, res) => {
  const { posisi_kerja_utama, tipe_personel, daftar_nama } = req.body;

  if (!posisi_kerja_utama || !tipe_personel || !daftar_nama) {
    return res.redirect("/personel/tambah-bulk");
  }

  // Ubah teks dari textarea menjadi array nama, hapus baris kosong
  const names = daftar_nama
    .split("\n")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  if (names.length === 0) {
    return res.redirect("/personel/tambah-bulk");
  }

  // Siapkan data untuk multi-insert
  const values = names.map((name) => [name, tipe_personel, posisi_kerja_utama]);
  const query =
    "INSERT INTO personel (nama_lengkap, tipe_personel, posisi_kerja_utama) VALUES ?";

  try {
        await pool.query(query, [values]);
        await logAdminAction(
      req,
      'CREATE',
      'personel',
      null,
      `Tambah bulk personel (sama posisi): ${names.length} data, posisi: ${posisi_kerja_utama}, tipe: ${tipe_personel}`
    );
        res.redirect("/personel?status=bulk_sukses"); // Redirect dengan status
    } catch (err) {
        console.error("Gagal menambah banyak personel:", err);
        res.redirect("/personel?status=gagal");
    }
});

// Ganti rute POST /personel/tambah-bulk-beda yang lama
app.post("/personel/tambah-bulk-beda",requireLogin, async (req, res) => {
    try {
        const { tipe_personel_beda, data_lengkap } = req.body;

        if (!tipe_personel_beda || !data_lengkap) {
            return res.redirect("/personel");
        }

        // 1. Ambil semua posisi yang valid dari database
        const [posisiRows] = await pool.query("SELECT nama_posisi FROM posisi_kerja");
        const validPosisi = new Set(posisiRows.map(p => p.nama_posisi));

        // 2. Proses input dari textarea
        const lines = data_lengkap.split("\n").map(line => line.trim()).filter(line => line);
        
        const valuesToInsert = [];
        const failedEntries = [];

        for (const line of lines) {
            const parts = line.split(',');
            if (parts.length < 2) continue; // Lewati baris dengan format salah

            const nama = parts[0].trim();
            const posisi = parts.slice(1).join(',').trim();

            // 3. Validasi: Cek apakah posisi ada di dalam daftar yang valid
            if (nama && posisi && validPosisi.has(posisi)) {
                valuesToInsert.push([nama, tipe_personel_beda, posisi]);
            } else {
                failedEntries.push(line); // Catat entri yang gagal
            }
        }

        // 4. Hanya jalankan INSERT jika ada data yang valid
        if (valuesToInsert.length > 0) {
            const query = "INSERT INTO personel (nama_lengkap, tipe_personel, posisi_kerja_utama) VALUES ?";
            await pool.query(query, [valuesToInsert]);
            await logAdminAction(
        req,
        'CREATE',
        'personel',
        null,
        `Tambah bulk personel (beda posisi): ${valuesToInsert.length} data, tipe: ${tipe_personel_beda}`
      );
        }

        // 5. Siapkan pesan untuk notifikasi dan redirect
        let redirectUrl = `/personel?status=bulk_result&berhasil=${valuesToInsert.length}&gagal=${failedEntries.length}`;
        if(failedEntries.length > 0) {
            // Encode pesan error agar aman di URL
            redirectUrl += `&pesan_gagal=${encodeURIComponent(failedEntries.join('; '))}`;
        }
        res.redirect(redirectUrl);

    } catch (error) {
        console.error("Gagal menambah banyak personel:", error);
        res.redirect("/personel?status=gagal");
    }
});

// Rute untuk MENAMPILKAN halaman impor
app.get("/personel/impor", requireLogin,(req, res) => {
  res.render("impor", {
    title: "Impor Personel dari Excel",
  });
});

// Rute untuk MEMPROSES file Excel yang di-upload
// 'upload.single('fileExcel')' adalah middleware dari multer
app.post("/personel/impor",requireLogin, upload.single("fileExcel"), async (req, res) => {
  if (!req.file) {
    return res
      .status(400)
      .json({ success: false, message: "Tidak ada file yang di-upload." });
  }

  const filePath = req.file.path;

  try {
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];

    // Validasi Header
    const requiredHeaders = [
      "Nama Lengkap",
      "Tipe Personel",
      "Posisi Kerja Utama",
    ];
    const rows = xlsx.utils.sheet_to_json(worksheet, { header: 1, defval: "" });
    const headerInFile = rows.length > 0 ? rows[0] : [];
    const allHeadersPresent = requiredHeaders.every((header) =>
      headerInFile.includes(header)
    );

    if (!allHeadersPresent) {
      fs.unlinkSync(filePath);
      return res.status(400).json({
        success: false,
        message:
          "Format header salah! Pastikan kolom berisi: Nama Lengkap, Tipe Personel, Posisi Kerja Utama.",
      });
    }

    const dataFromExcel = xlsx.utils.sheet_to_json(worksheet);
    if (dataFromExcel.length === 0) {
      fs.unlinkSync(filePath);
      return res
        .status(400)
        .json({ success: false, message: "File Excel tidak boleh kosong." });
    }

    const values = dataFromExcel.map((row) => [
      row["Nama Lengkap"],
      row["Tipe Personel"],
      row["Posisi Kerja Utama"],
    ]);
    const query =
      "INSERT INTO personel (nama_lengkap, tipe_personel, posisi_kerja_utama) VALUES ?";

    const [result] = await pool.query(query, [values]);
    fs.unlinkSync(filePath);

    res.json({
      success: true,
      message: `Berhasil mengimpor ${result.affectedRows} data personel.`,
    });
  } catch (error) {
    fs.unlinkSync(filePath);
    console.error(error);
    res
      .status(500)
      .json({ success: false, message: "Gagal memproses file Excel." });
  }
});

// Rute untuk mengekspor jadwal ke Excel
// Di dalam app.js


app.get("/jadwal/ekspor",requireLogin, async (req, res) => {
    try {
        const { tanggalMulai, tanggalAkhir } = req.query;
        if (!tanggalMulai || !tanggalAkhir) {
            return res.status(400).send("Harap tentukan rentang tanggal.");
        }

        // 1. Ambil data personel yang punya jadwal
        const [personel] = await pool.query(`
            SELECT DISTINCT p.id_personel, p.nama_lengkap, p.posisi_kerja_utama 
            FROM personel p
            JOIN jadwal j ON p.id_personel = j.id_personel
            WHERE j.tanggal_jadwal BETWEEN ? AND ?
            ORDER BY p.posisi_kerja_utama, p.nama_lengkap
        `, [tanggalMulai, tanggalAkhir]);

        // 2. Ambil data jadwal
        const [jadwalData] = await pool.query(`
            SELECT 
                j.id_personel, 
                DATE_FORMAT(j.tanggal_jadwal, '%Y-%m-%d') as tanggal_jadwal, 
                s.nama_shift 
            FROM jadwal j 
            JOIN shift s ON j.id_shift = s.id_shift 
            WHERE j.tanggal_jadwal BETWEEN ? AND ?
        `, [tanggalMulai, tanggalAkhir]);

        // 3. Ambil data batasan/cuti
        const [batasanData] = await pool.query(`
            SELECT id_personel, tanggal_mulai, tanggal_akhir, jenis_batasan
            FROM batasan_preferensi
            WHERE tanggal_mulai <= ? AND tanggal_akhir >= ?
        `, [tanggalAkhir, tanggalMulai]);

        // 4. Buat array tanggal string
        function parseDate(str) {
            const [year, month, day] = str.split('-').map(Number);
            return new Date(year, month - 1, day);
        }
        const dates = [];
        let currentDate = parseDate(tanggalMulai);
        const endDate = parseDate(tanggalAkhir);
        while (currentDate <= endDate) {
            const yyyy = currentDate.getFullYear();
            const mm = String(currentDate.getMonth() + 1).padStart(2, '0');
            const dd = String(currentDate.getDate()).padStart(2, '0');
            dates.push(`${yyyy}-${mm}-${dd}`);
            currentDate.setDate(currentDate.getDate() + 1);
        }

        // 5. Buat jadwalMap
        const jadwalMap = new Map();
        jadwalData.forEach(j => {
            const key = `${j.id_personel}-${j.tanggal_jadwal}`;
            jadwalMap.set(key, j.nama_shift);
        });

        // 6. Buat cutiLookup
        const cutiLookup = new Map();
        batasanData.forEach(b => {
            let cur = new Date(b.tanggal_mulai);
            const end = new Date(b.tanggal_akhir);
            while (cur <= end) {
                const yyyy = cur.getFullYear();
                const mm = String(cur.getMonth() + 1).padStart(2, '0');
                const dd = String(cur.getDate()).padStart(2, '0');
                const tgl = `${yyyy}-${mm}-${dd}`;
                cutiLookup.set(`${b.id_personel}-${tgl}`, b.jenis_batasan || 'CUTI');
                cur.setDate(cur.getDate() + 1);
            }
        });

        // 7. Pivot data personel yang punya jadwal
        const pivotData = {};
        personel.forEach(p => {
            const posisi = p.posisi_kerja_utama || 'Tanpa Posisi';
            if (!pivotData[posisi]) pivotData[posisi] = [];
            const personelJadwal = {
                id_personel: p.id_personel,
                nama_lengkap: p.nama_lengkap,
                posisi_kerja_utama: p.posisi_kerja_utama,
                jadwal: {}
            };
            dates.forEach(date => {
                const key = `${p.id_personel}-${date}`;
                personelJadwal.jadwal[date] = jadwalMap.get(key) || '';
            });
            pivotData[posisi].push(personelJadwal);
        });

        // 8. Tambahkan personel cuti yang tidak ada di jadwal
        const idPersonelSudahAda = new Set(personel.map(p => p.id_personel));
        const [allPersonel] = await pool.query(`SELECT id_personel, nama_lengkap, posisi_kerja_utama FROM personel`);
        batasanData.forEach(b => {
            if (!idPersonelSudahAda.has(b.id_personel)) {
                const p = allPersonel.find(x => x.id_personel === b.id_personel);
                if (!p) return;
                const posisi = p.posisi_kerja_utama || 'Tanpa Posisi';
                if (!pivotData[posisi]) pivotData[posisi] = [];
                if (pivotData[posisi].some(x => x.id_personel === p.id_personel)) return;
                const personelJadwal = {
                    id_personel: p.id_personel,
                    nama_lengkap: p.nama_lengkap,
                    posisi_kerja_utama: p.posisi_kerja_utama,
                    jadwal: {}
                };
                dates.forEach(date => {
                    personelJadwal.jadwal[date] = '';
                });
                pivotData[posisi].push(personelJadwal);
            }
        });

        // 9. Buat file Excel dengan ExcelJS
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Jadwal Personel');

        // Header 2 baris
        const headerHari = ['No.', 'Nama', 'Posisi', ...dates.map(date => {
            const d = new Date(date);
            return d.toLocaleDateString('id-ID', { weekday: 'long' });
        })];
        const headerTanggal = ['', '', '', ...dates.map(date => {
            const d = new Date(date);
            return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' });
        })];

        worksheet.addRow(headerHari);
        worksheet.addRow(headerTanggal);

        worksheet.mergeCells('A1:A2');
        worksheet.mergeCells('B1:B2');
        worksheet.mergeCells('C1:C2');
        ['A1', 'B1', 'C1'].forEach(cell => {
            worksheet.getCell(cell).alignment = { vertical: 'middle', horizontal: 'center' };
        });
        for (let i = 4; i < 4 + dates.length; i++) {
            worksheet.getCell(1, i).alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
            worksheet.getCell(2, i).alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
            worksheet.getColumn(i).width = 12;
        }

        // DATA
                // Tambahkan sebelum loop DATA
        const daftarWarna = [
            'FF809FFF', 'FF1CC88A', 'FF36B9CC', 'FFF6C23E', 'FFE74A3B',
            'FFD112E2', 'FF5A5C69', 'FFF1960E', 'FF5E72E4', 'FFF5365C'
        ];
                // ...existing code...
        
        const posisiList = Object.keys(pivotData).sort();
        const posisiWarnaMap = {};
        posisiList.forEach((posisi, i) => {
            posisiWarnaMap[posisi] = daftarWarna[i % daftarWarna.length];
        });
        
        posisiList.forEach(posisi => {
            if (pivotData[posisi].length > 0) {
                // Buat array kosong sepanjang jumlah kolom (No, Nama, Posisi, hari-tanggal)
                const totalKolom = 3 + dates.length;
                const headerArray = Array(totalKolom).fill('');
                headerArray[0] = ` ${posisi}`;
                const row = worksheet.addRow(headerArray);
        
                // Merge seluruh kolom header posisi
                worksheet.mergeCells(row.number, 1, row.number, totalKolom);
        
                // Set warna background dan font putih tebal untuk seluruh kolom header posisi
                const warna = posisiWarnaMap[posisi];
                for (let i = 1; i <= totalKolom; i++) {
                    const cell = row.getCell(i);
                    cell.fill = {
                        type: 'pattern',
                        pattern: 'solid',
                        fgColor: { argb: warna }
                    };
                    cell.font = { color: { argb: 'FFFFFFFF' }, bold: true };
                    cell.alignment = { vertical: 'middle', horizontal: 'left' };
                }
        
                pivotData[posisi].forEach((p, index) => {
                    const posisiWrap = p.posisi_kerja_utama || 'Tanpa Posisi';
                    const rowData = [index + 1, p.nama_lengkap, posisiWrap];
                    dates.forEach(date => {
                        if (cutiLookup.has(`${p.id_personel}-${date}`)) {
                            rowData.push('CUTI');
                        } else {
                            rowData.push(p.jadwal[date] || '');
                        }
                    });
                    const dataRow = worksheet.addRow(rowData);
        
                    // WRAP TEXT dan rata tengah untuk kolom tanggal (mulai kolom ke-4)
                    for (let i = 4; i < 4 + dates.length; i++) {
                        dataRow.getCell(i).alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' };
                        worksheet.getColumn(i).width = 12;
                        if (dataRow.getCell(i).value === 'CUTI') {
                            dataRow.getCell(i).fill = {
                                type: 'pattern',
                                pattern: 'solid',
                                fgColor: { argb: 'FFD1D5DB' }
                            };
                            dataRow.getCell(i).font = { color: { argb: 'FF374151' }, bold: true };
                        } else if (!dataRow.getCell(i).value) {
                            dataRow.getCell(i).fill = {
                                type: 'pattern',
                                pattern: 'solid',
                                fgColor: { argb: 'FFFF0000' }
                            };
                            dataRow.getCell(i).border = {
                                top:    { style: 'thin', color: { argb: 'FF000000' } },
                                left:   { style: 'thin', color: { argb: 'FF000000' } },
                                bottom: { style: 'thin', color: { argb: 'FF000000' } },
                                right:  { style: 'thin', color: { argb: 'FF000000' } }
                            };
                        }
                    }
                    dataRow.getCell(3).alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' };
                    worksheet.getColumn(3).width = 40;
                    dataRow.getCell(2).alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' };
                    worksheet.getColumn(2).width = 30;
                    dataRow.getCell(1).alignment = { vertical: 'middle', horizontal: 'center' };
                    worksheet.getColumn(1).width = 6;
                });
            }
        });

        worksheet.columns = [
            { width: 5 }, { width: 30 }, { width: 25 },
            ...dates.map(() => ({ width: 15 }))
        ];

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="Jadwal_Personel_${tanggalMulai}_sd_${tanggalAkhir}.xlsx"`);

        await workbook.xlsx.write(res);
        res.end();

    } catch (error) {
        console.error("--- GAGAL MEMBUAT FILE EXCEL ---", error);
        res.status(500).send("Server Error saat membuat file Excel.");
    }
});

// API untuk mengambil data jadwal dalam format JSON untuk FullCalendar
app.get("/api/jadwal", requireLogin, async (req, res) => {
    try {
        const { start, end } = req.query;

        // 1. Ambil semua posisi dan berikan warna unik
        const [posisi] = await pool.query("SELECT id_posisi, nama_posisi FROM posisi_kerja");
        const warnaPosisi = {};
        const daftarWarna = ['#809fffff', '#1cc88a', '#36b9cc', '#f6c23e', '#e74a3b', '#d112e2ff', '#5a5c69', '#f1960eff', '#5e72e4', '#f5365c'];
        posisi.forEach((p, i) => {
            warnaPosisi[p.id_posisi] = daftarWarna[i % daftarWarna.length];
        });

        // 2. Ambil data jadwal seperti biasa
        const query = `
            SELECT j.id_jadwal, j.tanggal_jadwal, j.id_posisi, p.nama_lengkap, 
                   pos.nama_posisi, s.nama_shift 
            FROM jadwal j 
            LEFT JOIN personel p ON j.id_personel = p.id_personel 
            LEFT JOIN posisi_kerja pos ON j.id_posisi = pos.id_posisi 
            LEFT JOIN shift s ON j.id_shift = s.id_shift 
            WHERE j.tanggal_jadwal BETWEEN ? AND ?`;
        
        const [results] = await pool.query(query, [start, end]);

        // 3. Format event untuk kalender dengan metode yang benar
        const events = results.map((row) => ({
            id: row.id_jadwal,
            title: row.nama_lengkap || "SLOT KOSONG",
            start: toYYYYMMDD(row.tanggal_jadwal), // <-- PERBAIKAN UTAMA DI SINI
            allDay: true,
            description: `${row.nama_posisi || ''} - ${row.nama_shift || ''}`,
            posisi: row.nama_posisi || '-',
            backgroundColor: warnaPosisi[Number(row.id_posisi)] || '#575757ff',
            borderColor: warnaPosisi[Number(row.id_posisi)] || '#575757ff',
        }));
        
        res.json(events);
    } catch (err) {
        console.error("Error fetching calendar data:", err);
        res.status(500).json({ error: "Gagal mengambil data jadwal" });
    }
});

// API untuk menangani update jadwal dari drag-and-drop
app.post("/api/jadwal/update", requireLogin,async (req, res) => {
  const { id, tanggalBaru } = req.body;
  if (!id || !tanggalBaru) {
    return res.status(400).json({ message: "Data tidak lengkap" });
  }

  const query =
    "UPDATE jadwal SET tanggal_jadwal = ?, status_jadwal = 'Manual Diedit' WHERE id_jadwal = ?";
  try {
    await pool.query(query, [tanggalBaru, id]);
    res.json({ message: "Jadwal berhasil diperbarui" });
  } catch (err) {
    console.error("Error updating schedule from drag-drop:", err);
    res.status(500).json({ message: "Gagal update jadwal" });
  }
});


// API untuk mengambil data satu personel dalam format JSON
app.get("/api/personel/:id",requireLogin, async (req, res) => {
  const personelId = req.params.id;
  const query = "SELECT * FROM personel WHERE id_personel = ?";
  try {
    const [results] = await pool.query(query, [personelId]);
    if (!results || results.length === 0) {
      return res.status(404).json({ message: "Personel tidak ditemukan" });
    }
    res.json(results[0]);
  } catch (err) {
    res.status(500).json({ message: "Gagal mengambil data personel" });
  }
});

// API untuk mengambil data satu jadwal dalam format JSON
app.get("/api/jadwal/:id", requireLogin, async (req, res) => {
  const jadwalId = req.params.id;
  const query = `
        SELECT j.id_jadwal, j.id_personel, j.id_posisi, j.id_shift, j.tanggal_jadwal
        FROM jadwal j
        WHERE j.id_jadwal = ?
    `;
  try {
    const [results] = await pool.query(query, [jadwalId]);
    if (!results || results.length === 0) {
      return res.status(404).json({ message: "Jadwal tidak ditemukan." });
    }
    res.json(results[0]);
  } catch (err) {
    res.status(500).json({ message: "Gagal mengambil data jadwal" });
  }
});

app.get("/api/jadwal-all", requireLogin, async (req, res) => {
    try {
        const { start, end } = req.query;
        if (!start || !end) {
            return res.status(400).json({ message: "Parameter tanggal start dan end diperlukan." });
        }
        const query = `
            SELECT 
                DATE_FORMAT(j.tanggal_jadwal, '%Y-%m-%d') as start, 
                p.nama_lengkap as title, 
                p.posisi_kerja_utama, 
                CONCAT(pos.nama_posisi, ' - ', s.nama_shift) as description
            FROM jadwal j 
            LEFT JOIN personel p ON j.id_personel = p.id_personel 
            LEFT JOIN posisi_kerja pos ON j.id_posisi = pos.id_posisi 
            LEFT JOIN shift s ON j.id_shift = s.id_shift 
            WHERE j.tanggal_jadwal BETWEEN ? AND ?`;
        const [results] = await pool.query(query, [start, end]);
        res.json({ events: results });
    } catch (err) {
        console.error("Error fetching all schedule data:", err);
        res.status(500).json({ error: "Gagal mengambil data semua jadwal" });
    }
});

app.post("/generate-jadwal-spesifik", requireLogin, async (req, res) => {
    try {
        const { tanggalMulai, tanggalAkhir, 'personel_terpilih': selectedIds } = req.body;

        if (!tanggalMulai || !tanggalAkhir || !selectedIds || selectedIds.length === 0) {
            return res.status(400).send("Data tidak lengkap. Harap isi tanggal dan pilih personel.");
        }

        // --- PERBAIKAN DESTRUCTURING DI SINI ---
        const [
            [personelToSchedule], [shifts], [posisiKerja], [batasan]
        ] = await Promise.all([
            pool.query("SELECT id_personel, posisi_kerja_utama FROM personel WHERE id_personel IN (?)", [selectedIds]),
            pool.query("SELECT id_shift FROM shift"),
            pool.query("SELECT id_posisi, nama_posisi FROM posisi_kerja"),
            pool.query("SELECT id_personel, tanggal_mulai, tanggal_akhir FROM batasan_preferensi WHERE tanggal_mulai <= ? AND tanggal_akhir >= ?", [tanggalAkhir, tanggalMulai])
        ]);

        if (personelToSchedule.length === 0 || shifts.length === 0) {
            return res.status(400).send("Personel atau data shift tidak ditemukan.");
        }

        // Logika selanjutnya sudah benar
        const batasanLookup = new Set();
        batasan.forEach(b => {
            let currentDate = new Date(b.tanggal_mulai);
            const endDate = new Date(b.tanggal_akhir);
            while (currentDate <= endDate) {
                const dateString = toYYYYMMDD(currentDate);
                batasanLookup.add(`${b.id_personel}-${dateString}`);
                currentDate.setDate(currentDate.getDate() + 1);
            }
        });

        const shiftIds = shifts.map(s => s.id_shift);
        const posisiNameToIdMap = new Map(posisiKerja.map(p => [p.nama_posisi, p.id_posisi]));
        
        await pool.query("DELETE FROM jadwal WHERE tanggal_jadwal BETWEEN ? AND ? AND id_personel IN (?)", [tanggalMulai, tanggalAkhir, selectedIds]);

        for (let loopDate = new Date(tanggalMulai); loopDate <= new Date(tanggalAkhir); loopDate.setDate(loopDate.getDate() + 1)) {
            const tanggalSQL = toYYYYMMDD(loopDate);
            for (const p of personelToSchedule) {
                const lookupKey = `${p.id_personel}-${tanggalSQL}`;
                if (batasanLookup.has(lookupKey)) continue;

                if (!p.posisi_kerja_utama || !posisiNameToIdMap.has(p.posisi_kerja_utama)) continue;

                const idPosisi = posisiNameToIdMap.get(p.posisi_kerja_utama);
                const randomShiftId = shiftIds[Math.floor(Math.random() * shiftIds.length)];
                
                await pool.query("INSERT INTO jadwal (tanggal_jadwal, id_personel, id_posisi, id_shift, status_jadwal) VALUES (?, ?, ?, ?, 'Otomatis')", [tanggalSQL, p.id_personel, idPosisi, randomShiftId]);
            }
        }
        
        res.redirect("/jadwal?status=success&tab=tabel");
    } catch (error) {
        console.error("Error saat generate jadwal spesifik:", error);
        res.status(500).send("Terjadi error pada server saat membuat jadwal.");
    }
});


// Rute BARU untuk halaman rekap cuti
app.get('/cuti', requireLogin, async (req, res) => {
    try {
        const dataPerPage = 10;
        const currentPage = parseInt(req.query.page) || 1;
        const offset = (currentPage - 1) * dataPerPage;
        const { search } = req.query;

        let whereClause = '';
        let queryParams = [];

        if (search) {
            whereClause = 'WHERE nama_lengkap LIKE ?';
            queryParams.push(`%${search}%`);
        }

        const countQuery = `SELECT COUNT(*) as total FROM personel ${whereClause}`;
        const [[{ total }]] = await pool.query(countQuery, queryParams);
        const totalPages = Math.ceil(total / dataPerPage);

        const personelQuery = `SELECT id_personel, nama_lengkap, posisi_kerja_utama, jatah_cuti, cuti_terpakai FROM personel ${whereClause} ORDER BY nama_lengkap LIMIT ? OFFSET ?`;
        const [personel] = await pool.query(personelQuery, [...queryParams, dataPerPage, offset]);

        res.render('cuti', {
            title: 'Rekapitulasi Jatah Cuti',
            personel,
            currentPage,
            totalPages,
            query: req.query,
            currentPath: req.path
        });
    } catch (error) {
        console.error("Error fetching cuti data:", error);
        res.status(500).send("Server Error");
    }
});

// Ganti rute POST /api/cuti/update yang lama
app.post('/api/cuti/update', requireLogin,  async (req, res) => {
    try {
        // Hanya ambil jatah_cuti dan id_personel dari body
        const { id_personel, jatah_cuti } = req.body;
        if (!id_personel || jatah_cuti === undefined) {
            return res.status(400).json({ success: false, message: 'Data tidak lengkap.' });
        }
        
        // Query hanya mengupdate jatah_cuti
        await pool.query(
            "UPDATE personel SET jatah_cuti = ? WHERE id_personel = ?",
            [jatah_cuti, id_personel]
        );
        // Logging aktivitas admin
        await logAdminAction(req, 'UPDATE', 'personel', id_personel, `Update jatah cuti: ${jatah_cuti}`);
        
        res.json({ success: true, message: 'Jatah cuti berhasil diperbarui.' });
    } catch (error) {
        console.error("Gagal update data cuti:", error);
        res.status(500).json({ success: false, message: 'Terjadi kesalahan di server.' });
    }
});

app.post('/api/cuti/reset/:id', requireLogin, async (req, res) => {
    try {
        const personelId = req.params.id;
        const defaultJatahCuti = 12;
        const defaultCutiTerpakai = 0;

        const [result] = await pool.query(
            "UPDATE personel SET jatah_cuti = ?, cuti_terpakai = ? WHERE id_personel = ?",
            [defaultJatahCuti, defaultCutiTerpakai, personelId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Personel tidak ditemukan.' });
        }

        // Tambahkan log admin
        await logAdminAction(req, 'RESET', 'personel', personelId, `Reset cuti ke default (${defaultJatahCuti})`);

        res.json({ success: true, message: 'Data cuti personel berhasil direset.' });

    } catch (error) {
        console.error("Gagal mereset data cuti perorangan:", error);
        res.status(500).json({ success: false, message: 'Terjadi kesalahan di server.' });
    }
});

app.post('/api/cuti/reset-all', requireLogin, async (req, res) => {
    try {
        const defaultJatahCuti = 12;
        const defaultCutiTerpakai = 0;

        const [result] = await pool.query(
            "UPDATE personel SET jatah_cuti = ?, cuti_terpakai = ?",
            [defaultJatahCuti, defaultCutiTerpakai]
        );

        // Tambahkan log admin
        await logAdminAction(req, 'RESET_ALL', 'personel', null, `Reset cuti semua personel ke default (${defaultJatahCuti})`);

        res.json({ 
            success: true, 
            message: `${result.affectedRows} data cuti personel berhasil direset.` 
        });

    } catch (error) {
        console.error("Gagal mereset data cuti:", error);
        res.status(500).json({ success: false, message: 'Terjadi kesalahan di server.' });
    }
});

app.get("/api/personel-all", requireLogin, async (req, res) => {
    try {
        const [personel] = await pool.query("SELECT id_personel, nama_lengkap, posisi_kerja_utama FROM personel ORDER BY nama_lengkap");
        res.json(personel);
    } catch (error) {
        res.status(500).json({ message: "Gagal mengambil data semua personel" });
    }
});

// Contoh Express route
app.get('/admin/history', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const user = req.query.user || '';
    const table = req.query.table || '';
    const limit = 10;
    const offset = (page - 1) * limit;

    // Ambil user unik untuk dropdown
    const [userRows] = await pool.query('SELECT DISTINCT username FROM admin_logs ORDER BY username');
    // Ambil nama tabel unik untuk dropdown
    const [tableRows] = await pool.query('SELECT DISTINCT table_name FROM admin_logs WHERE table_name IS NOT NULL AND table_name <> "" ORDER BY table_name');

    // Query log dengan filter user dan/atau tabel jika ada
    let where = [];
    let params = [];
    if (user) {
        where.push('username = ?');
        params.push(user);
    }
    if (table) {
        where.push('table_name = ?');
        params.push(table);
    }
    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    // Hitung total data
    const [[{ count }]] = await pool.query(`SELECT COUNT(*) as count FROM admin_logs ${whereClause}`, params);
    // Ambil data log
    const [logs] = await pool.query(
        `SELECT * FROM admin_logs ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
    );
    res.render('admin_history', {
        title: 'Riwayat Admin',
        logs,
        users: userRows,
        tables: tableRows,
        selectedUser: user,
        selectedTable: table,
        currentPage: page,
        totalPages: Math.ceil(count / limit),
        query: req.query
    });
});


// Jalankan Server
  app.listen(port, () => {
    console.log(`Server berjalan di http://localhost:${port}`);
  });
