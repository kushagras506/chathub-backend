const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const { OAuth2Client } = require('google-auth-library');
const fetch = require('node-fetch');
const bcrypt = require('bcrypt');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const callSessions = {};
const mainUserQueue = [];
const adultUserQueue = [];
let dbPool;
let onlineUsersCount = 0;

// This config object will be populated from the database on startup.
const config = {};
const client = new OAuth2Client(); // Initialize client, ID will be set after loading config.
const authenticatedUsers = {};
const ipCountryCache = new Map();

// --- Database Connection and Config Setup ---
async function initDb() {
  try {
    dbPool = await mysql.createPool({
      host: 'sdb-90.hosting.stackcp.net',
      user: 'chathub-353131392d6e',
      password: '8b6zn2tfx3',
      database: 'chathub-353131392d6e',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });

    // Create a settings table for API keys and other config
    await dbPool.execute(`
        CREATE TABLE IF NOT EXISTS settings (
            setting_key VARCHAR(255) PRIMARY KEY,
            setting_value TEXT
        )
    `);

    // Check if settings are seeded
    const [settingsRows] = await dbPool.execute('SELECT COUNT(*) as count FROM settings');
    if (settingsRows[0].count === 0) {
        console.log('Seeding settings table with default values...');
        await dbPool.query('INSERT INTO settings (setting_key, setting_value) VALUES ?', [[
            ['GOOGLE_CLIENT_ID', 'YOUR_GOOGLE_CLIENT_ID'],
        ]]);
    }

    // Create users table
    await dbPool.execute(`
      CREATE TABLE IF NOT EXISTS users (
        google_id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL,
        picture_url VARCHAR(2048),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Create connections table
    await dbPool.execute(`
      CREATE TABLE IF NOT EXISTS connections (
        id INT AUTO_INCREMENT PRIMARY KEY,
        socket_id VARCHAR(255) NOT NULL,
        user_id VARCHAR(255),
        ip_address VARCHAR(45),
        country VARCHAR(255),
        connect_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        disconnect_time TIMESTAMP NULL
      )
    `);
    
    // Create call_sessions table
    await dbPool.execute(`
        CREATE TABLE IF NOT EXISTS call_sessions (
            id INT AUTO_INCREMENT PRIMARY KEY,
            call_id VARCHAR(255) NOT NULL UNIQUE,
            user1_id VARCHAR(255) NOT NULL,
            user2_id VARCHAR(255) NOT NULL,
            user1_ip VARCHAR(45),
            user2_ip VARCHAR(45),
            user1_gender VARCHAR(50),
            user1_with_face BOOLEAN,
            user1_with_audio BOOLEAN,
            user1_selected_country VARCHAR(255),
            user1_gender_of_interest VARCHAR(50),
            user1_session_type VARCHAR(50),
            user2_gender VARCHAR(50),
            user2_with_face BOOLEAN,
            user2_with_audio BOOLEAN,
            user2_selected_country VARCHAR(255),
            user2_gender_of_interest VARCHAR(50),
            user2_session_type VARCHAR(50),
            start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            end_time TIMESTAMP NULL,
            duration_seconds INT NULL
        )
    `);

    // Create user_reports table
    await dbPool.execute(`
        CREATE TABLE IF NOT EXISTS user_reports (
            id INT AUTO_INCREMENT PRIMARY KEY,
            call_id VARCHAR(255) NOT NULL,
            reporter_user_id VARCHAR(255) NOT NULL,
            reported_user_id VARCHAR(255) NOT NULL,
            reported_ip_address VARCHAR(45),
            reason VARCHAR(255) NOT NULL,
            status ENUM('pending', 'reviewed', 'action_taken') DEFAULT 'pending',
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Create blocked_ips table
    await dbPool.execute(`
        CREATE TABLE IF NOT EXISTS blocked_ips (
            ip_address VARCHAR(45) PRIMARY KEY,
            reason TEXT,
            blocked_by_admin_id VARCHAR(255),
            block_expires_at TIMESTAMP NULL,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Create blocked_users table
    await dbPool.execute(`
        CREATE TABLE IF NOT EXISTS blocked_users (
            google_id VARCHAR(255) PRIMARY KEY,
            reason TEXT,
            blocked_by_admin_id VARCHAR(255),
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Create admins table with username and password hash
    await dbPool.execute(`
        CREATE TABLE IF NOT EXISTS admins (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(255) NOT NULL UNIQUE,
            password_hash VARCHAR(255) NOT NULL
        )
    `);
    
    // Create chat_logs table
    await dbPool.execute(`
      CREATE TABLE IF NOT EXISTS chat_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        call_id VARCHAR(255) NOT NULL,
        user_id VARCHAR(255) NOT NULL,
        ip_address VARCHAR(45) NOT NULL,
        country VARCHAR(255) NULL,
        message TEXT NOT NULL,
        is_clean BOOLEAN NOT NULL,
        moderation_reason VARCHAR(255) NULL,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Create admin_warnings table
    await dbPool.execute(`
        CREATE TABLE IF NOT EXISTS admin_warnings (
            id INT AUTO_INCREMENT PRIMARY KEY,
            admin_id VARCHAR(255) NOT NULL,
            user_id VARCHAR(255) NOT NULL,
            message TEXT NOT NULL,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Create countries table
    await dbPool.execute(`
        CREATE TABLE IF NOT EXISTS countries (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(255) NOT NULL UNIQUE,
            code VARCHAR(10),
            emoji VARCHAR(10)
        )
    `);

  } catch (error) {
    console.error('Failed to initialize the database:', error);
    process.exit(1);
  }
}

async function loadConfigAndSeed() {
    try {
        const [rows] = await dbPool.execute('SELECT * FROM settings');
        rows.forEach(row => {
            config[row.setting_key] = row.setting_value;
        });

        // Set the Google Client ID for the OAuth2 client
        client._clientId = config.GOOGLE_CLIENT_ID;
        console.log('Configuration loaded from database.');

        // Seed admins table if empty with a default user
        const [adminRows] = await dbPool.execute('SELECT COUNT(*) as count FROM admins');
        if (adminRows[0].count === 0) {
            console.log('Seeding admins table with default admin...');
            const defaultPassword = 'admin123';
            const saltRounds = 10;
            const passwordHash = await bcrypt.hash(defaultPassword, saltRounds);
            await dbPool.execute("INSERT INTO admins (username, password_hash) VALUES (?, ?)", ['admin', passwordHash]);
            console.log('--- DEFAULT ADMIN CREDENTIALS ---');
            console.log('Username: admin');
            console.log('Password: admin123');
            console.log('---------------------------------');
        }

        // Seed countries table if empty
        const [countryRows] = await dbPool.execute('SELECT COUNT(*) as count FROM countries');
        if (countryRows[0].count === 0) {
            console.log('Seeding countries table...');
            const countriesToSeed = [
                { name: 'Any Country', code: null, emoji: '🌍' }, { name: 'USA', code: 'us', emoji: '🇺🇸' },
                { name: 'Canada', code: 'ca', emoji: '🇨🇦' }, { name: 'UK', code: 'gb', emoji: '🇬🇧' },
                { name: 'Australia', code: 'au', emoji: '🇦🇺' }, { name: 'Germany', code: 'de', emoji: '🇩🇪' },
                { name: 'France', code: 'fr', emoji: '🇫🇷' }, { name: 'Japan', code: 'jp', emoji: '🇯🇵' },
                { name: 'India', code: 'in', emoji: '🇮🇳' }, { name: 'Brazil', code: 'br', emoji: '🇧🇷' },
                { name: 'Mexico', code: 'mx', emoji: '🇲🇽' }, { name: 'Russia', code: 'ru', emoji: '🇷🇺' },
                { name: 'China', code: 'cn', emoji: '🇨🇳' }, { name: 'Italy', code: 'it', emoji: '🇮🇹' },
                { name: 'Spain', code: 'es', emoji: '🇪🇸' }, { name: 'South Korea', code: 'kr', emoji: '🇰🇷' },
                { name: 'Egypt', code: 'eg', emoji: '🇪🇬' }, { name: 'Nigeria', code: 'ng', emoji: '🇳🇬' },
                { name: 'Argentina', code: 'ar', emoji: '🇦🇷' },
            ];
            const countryValues = countriesToSeed.map(c => [c.name, c.code, c.emoji]);
            await dbPool.query('INSERT INTO countries (name, code, emoji) VALUES ?', [countryValues]);
        }

    } catch (error) {
        console.error('Failed to load configuration or seed data:', error);
        process.exit(1);
    }
}

function isAdmin(socket) {
    return socket.isAdmin === true;
}

function findSocketByIpOrId(ipAddress, userId) {
    for (const socket of io.sockets.sockets.values()) {
        if(socket.userId === userId) {
            return socket;
        }
        if (socket.handshake.address === ipAddress) {
            return socket;
        }
    }
    return null;
}

function moderateMessage(message) {
    const badWords = ['badword', 'swear', 'abuse']; // Example bad words
    const lowercaseMessage = message.toLowerCase();
    for (const word of badWords) {
        if (lowercaseMessage.includes(word)) {
            return { isClean: false, reason: `Contains a moderated keyword: '${word}'` };
        }
    }
    return { isClean: true, reason: null };
}

async function getCountryFromIp(ip) {
    if (ipCountryCache.has(ip)) {
        return ipCountryCache.get(ip);
    }
    try {
        if (!ip) return 'Unknown';
        const response = await fetch(`http://ip-api.com/json/${ip}`);
        const data = await response.json();
        if (data && data.status === 'success') {
            ipCountryCache.set(ip, data.country);
            return data.country;
        }
    } catch (error) {
        console.error('Failed to fetch country from IP:', error);
    }
    return 'Unknown';
}

async function findPartnerAndMatch(socket, metadata) {
    const userQueue = metadata.sessionType === 'Adult' ? adultUserQueue : mainUserQueue;
    const userIp = socket.handshake.address;
    const userCountry = await getCountryFromIp(userIp);

    const currentUser = {
        socketId: socket.id,
        metadata,
        ipAddress: userIp,
        country: userCountry
    };

    let matchedPartnerIndex = -1;

    for (let i = 0; i < userQueue.length; i++) {
        const potentialPartner = userQueue[i];
        if (potentialPartner.socketId === currentUser.socketId) continue;

        const currentUserLikesPartner = (
            (currentUser.metadata.genderOfInterest === 'Couple' || currentUser.metadata.genderOfInterest === potentialPartner.metadata.gender) &&
            (currentUser.metadata.selectedCountry === 'Any Country' || currentUser.metadata.selectedCountry === potentialPartner.country) &&
            (!currentUser.metadata.withFace || potentialPartner.metadata.withFace === true) &&
            (!currentUser.metadata.withAudio || potentialPartner.metadata.withAudio === true)
        );

        const partnerLikesCurrentUser = (
            (potentialPartner.metadata.genderOfInterest === 'Couple' || potentialPartner.metadata.genderOfInterest === currentUser.metadata.gender) &&
            (potentialPartner.metadata.selectedCountry === 'Any Country' || potentialPartner.metadata.selectedCountry === currentUser.country) &&
            (!potentialPartner.metadata.withFace || currentUser.metadata.withFace === true) &&
            (!potentialPartner.metadata.withAudio || currentUser.metadata.withAudio === true)
        );

        if (currentUserLikesPartner && partnerLikesCurrentUser) {
            matchedPartnerIndex = i;
            break;
        }
    }

    if (matchedPartnerIndex !== -1) {
        const partner = userQueue.splice(matchedPartnerIndex, 1)[0];
        const callId = crypto.randomUUID();

        callSessions[callId] = {
            users: [currentUser.socketId, partner.socketId],
            ips: {
                [currentUser.socketId]: currentUser.ipAddress,
                [partner.socketId]: partner.ipAddress,
            },
            metadata: [currentUser.metadata, partner.metadata]
        };

        try {
            const user1Socket = io.sockets.sockets.get(currentUser.socketId);
            const user2Socket = io.sockets.sockets.get(partner.socketId);
            const user1Id = user1Socket.userId;
            const user2Id = user2Socket.userId;
            const user1Meta = currentUser.metadata;
            const user2Meta = partner.metadata;
            await dbPool.execute(
                `INSERT INTO call_sessions (
              call_id, user1_id, user2_id, user1_ip, user2_ip, 
              user1_gender, user1_with_face, user1_with_audio, user1_selected_country, user1_gender_of_interest, user1_session_type,
              user2_gender, user2_with_face, user2_with_audio, user2_selected_country, user2_gender_of_interest, user2_session_type
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    callId, user1Id, user2Id, currentUser.ipAddress, partner.ipAddress,
                    user1Meta.gender, user1Meta.withFace, user1Meta.withAudio, user1Meta.selectedCountry, user1Meta.genderOfInterest, user1Meta.sessionType,
                    user2Meta.gender, user2Meta.withFace, user2Meta.withAudio, user2Meta.selectedCountry, user2Meta.genderOfInterest, user2Meta.sessionType
                ]
            );
        } catch (dbError) {
            console.error('Failed to log new call session:', dbError);
        }

        const socket1 = io.sockets.sockets.get(currentUser.socketId);
        const socket2 = io.sockets.sockets.get(partner.socketId);

        if (socket1 && socket2) {
            socket1.join(callId);
            socket2.join(callId);

            const user1Payload = {
                callId,
                isInitiator: true,
                partnerMetadata: partner.metadata
            };
            if (isAdmin(socket1)) {
                user1Payload.partnerAdminData = {
                    id: socket2.userId,
                    ip: partner.ipAddress
                };
            }

            const user2Payload = {
                callId,
                isInitiator: false,
                partnerMetadata: currentUser.metadata
            };
            if (isAdmin(socket2)) {
                user2Payload.partnerAdminData = {
                    id: socket1.userId,
                    ip: currentUser.ipAddress
                };
            }

            socket1.emit('matched', user1Payload);
            socket2.emit('matched', user2Payload);
            console.log(`Matched users ${currentUser.socketId} and ${partner.socketId} in call ${callId}`);
        } else {
            console.error('One or more sockets not found for matching.');
            if (partner) userQueue.unshift(partner);
        }
    } else {
        userQueue.push(currentUser);
        console.log(`User ${socket.id} added to ${metadata.sessionType} queue. Size: ${userQueue.length}`);
    }
}

async function getDashboardData() {
    try {
        const [reports] = await dbPool.execute("SELECT id, reported_ip_address, reason, timestamp, status FROM user_reports ORDER BY timestamp DESC LIMIT 50");
        const [blockedIps] = await dbPool.execute("SELECT * FROM blocked_ips ORDER BY timestamp DESC");
        const [blockedUsers] = await dbPool.execute("SELECT * FROM blocked_users ORDER BY timestamp DESC");
        
        const activeCalls = Object.entries(callSessions).map(([callId, session]) => {
            const socket1 = io.sockets.sockets.get(session.users[0]);
            const socket2 = io.sockets.sockets.get(session.users[1]);
            return {
                callId,
                user1Id: socket1 ? socket1.userId : 'Disconnected',
                user1Ip: session.ips[session.users[0]],
                user2Id: socket2 ? socket2.userId : 'Disconnected',
                user2Ip: session.ips[session.users[1]],
            }
        });

        return {
            onlineUsers: onlineUsersCount,
            activeCalls,
            reports,
            blockedIps,
            blockedUsers,
        };
    } catch (error) {
        console.error("Failed to fetch dashboard data:", error);
        return null;
    }
}

io.on('connection', async (socket) => {
  const ipAddress = socket.handshake.address;
  socket.isAdmin = false; // Default admin status to false
  socket.userId = `anonymous-${socket.id}`;

  try {
      const [rows] = await dbPool.execute(
        'SELECT ip_address FROM blocked_ips WHERE ip_address = ? AND (block_expires_at IS NULL OR block_expires_at > NOW())', 
        [ipAddress]
      );
      if (rows.length > 0) {
          console.log(`Blocking connection from IP: ${ipAddress}`);
          socket.emit('error', 'IP Blocked');
          return socket.disconnect(true);
      }
  } catch (dbError) {
      console.error('Failed to check for blocked IP:', dbError);
  }

  onlineUsersCount++;
  io.emit('online_users_count', onlineUsersCount);
  const country = await getCountryFromIp(ipAddress);
  console.log(`User connected: ${socket.id} from IP: ${ipAddress} (${country})`);
  
  try {
      await dbPool.execute('INSERT INTO connections (socket_id, ip_address, country, user_id) VALUES (?, ?, ?, ?)', [socket.id, ipAddress, country, socket.userId]);
  } catch(dbError) {
      console.error('Failed to log connection:', dbError);
  }

  socket.on('authenticate_with_google', async (token) => {
    try {
      const ticket = await client.verifyIdToken({ idToken: token, audience: config.GOOGLE_CLIENT_ID });
      const payload = ticket.getPayload();
      const userId = payload['sub'];

      // Check if the user is blocked by their Google ID
      const [blockedUserRows] = await dbPool.execute('SELECT google_id FROM blocked_users WHERE google_id = ?', [userId]);
      if (blockedUserRows.length > 0) {
        console.log(`Blocking connection from blocked user: ${userId}`);
        socket.emit('error', 'User Account Blocked');
        return socket.disconnect(true);
      }

      authenticatedUsers[socket.id] = userId;
      socket.userId = userId;
      
      await dbPool.execute(
          `INSERT INTO users (google_id, name, email, picture_url) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE name=?, email=?, picture_url=?, last_login=CURRENT_TIMESTAMP`,
          [userId, payload.name, payload.email, payload.picture, payload.name, payload.email, payload.picture]
      );
      
      await dbPool.execute('UPDATE connections SET user_id = ? WHERE socket_id = ?', [userId, socket.id]);

      console.log(`User ${socket.id} authenticated with Google ID: ${userId}`);
      socket.emit('auth_success', { 
          user: { id: userId, name: payload.name, picture: payload.picture },
          isAdmin: false // Google login does not grant admin rights
      });
    } catch (error) {
      console.error('Google token verification failed:', error);
      socket.emit('auth_error', { message: 'Authentication failed.' });
    }
  });

    socket.on('admin_login', async ({ username, password }) => {
        try {
            const [rows] = await dbPool.execute('SELECT * FROM admins WHERE username = ?', [username]);
            if (rows.length === 0) {
                return socket.emit('admin_login_failure', { message: 'Invalid username or password.' });
            }

            const admin = rows[0];
            const isMatch = await bcrypt.compare(password, admin.password_hash);

            if (isMatch) {
                socket.isAdmin = true;
                socket.userId = `admin-${admin.id}`;
                console.log(`Admin login successful for user: ${username} on socket ${socket.id}`);
                socket.emit('admin_login_success');
                const data = await getDashboardData();
                socket.emit('admin_dashboard_update', data);

            } else {
                console.log(`Admin login failed for user: ${username}`);
                socket.emit('admin_login_failure', { message: 'Invalid username or password.' });
            }
        } catch (error) {
            console.error('Admin login process failed:', error);
            socket.emit('admin_login_failure', { message: 'An internal error occurred.' });
        }
    });

    // New event to provide client-side config
    socket.on('get_config', () => {
        socket.emit('config', {
            GOOGLE_CLIENT_ID: config.GOOGLE_CLIENT_ID
        });
    });

  // New event to fetch countries from the database
  socket.on('get_countries', async () => {
    try {
      const [countries] = await dbPool.execute('SELECT name, code, emoji FROM countries ORDER BY name ASC');
      // Ensure 'Any Country' is always the first option
      const anyCountryIndex = countries.findIndex(c => c.name === 'Any Country');
      if (anyCountryIndex > 0) {
          const anyCountry = countries.splice(anyCountryIndex, 1)[0];
          countries.unshift(anyCountry);
      }
      socket.emit('countries_list', countries);
    } catch (dbError) {
      console.error('Failed to fetch countries:', dbError);
      socket.emit('error', { message: 'Could not load country list.' });
    }
  });

  socket.on('admin_block_user', async (data) => {
    if (!isAdmin(socket)) {
      return socket.emit('error', { message: 'Unauthorized' });
    }

    const { reportedUserId, reportedIpAddress, reason } = data;
    const adminId = socket.userId;

    try {
      // Block the IP address permanently
      if (reportedIpAddress) {
        await dbPool.execute(
          'INSERT INTO blocked_ips (ip_address, reason, blocked_by_admin_id, block_expires_at) VALUES (?, ?, ?, NULL) ON DUPLICATE KEY UPDATE reason=VALUES(reason), blocked_by_admin_id=VALUES(blocked_by_admin_id), block_expires_at=NULL',
          [reportedIpAddress, reason, adminId]
        );
        console.log(`Admin ${adminId} blocked IP: ${reportedIpAddress}`);
      }
      
      // Block the user account (if it's not an anonymous user)
      if (reportedUserId && !reportedUserId.startsWith('anonymous-')) {
        await dbPool.execute(
          'INSERT INTO blocked_users (google_id, reason, blocked_by_admin_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE reason=VALUES(reason), blocked_by_admin_id=VALUES(blocked_by_admin_id)',
          [reportedUserId, reason, adminId]
        );
        console.log(`Admin ${adminId} blocked User ID: ${reportedUserId}`);
      }

      // Find and disconnect the blocked user if they are currently online
      const targetSocket = findSocketByIpOrId(reportedIpAddress, reportedUserId);
      if (targetSocket) {
          targetSocket.emit('error', 'User Account Blocked');
          targetSocket.disconnect(true);
          console.log(`Disconnected blocked user with socket ID ${targetSocket.id}`);
      }

      socket.emit('admin_action_success', { message: 'User and/or IP blocked successfully.' });

    } catch (dbError) {
      console.error('Admin block failed:', dbError);
      socket.emit('error', { message: 'Failed to block user.' });
    }
  });
  
  // --- ADMIN PANEL SOCKETS ---
  socket.on('admin_get_dashboard_data', async () => {
    if (!isAdmin(socket)) return;
    const data = await getDashboardData();
    socket.emit('admin_dashboard_update', data);
  });
  
  socket.on('admin_unblock_ip', async (data) => {
    if (!isAdmin(socket)) return;
    try {
        await dbPool.execute("DELETE FROM blocked_ips WHERE ip_address = ?", [data.ipAddress]);
        console.log(`Admin ${socket.userId} unblocked IP: ${data.ipAddress}`);
        const freshData = await getDashboardData();
        io.sockets.sockets.forEach(s => {
            if (isAdmin(s)) s.emit('admin_dashboard_update', freshData);
        });
    } catch (error) {
        console.error("Failed to unblock IP:", error);
    }
  });
  
  socket.on('admin_unblock_user', async (data) => {
    if (!isAdmin(socket)) return;
    try {
        await dbPool.execute("DELETE FROM blocked_users WHERE google_id = ?", [data.googleId]);
        console.log(`Admin ${socket.userId} unblocked user: ${data.googleId}`);
        const freshData = await getDashboardData();
        io.sockets.sockets.forEach(s => {
            if (isAdmin(s)) s.emit('admin_dashboard_update', freshData);
        });
    } catch (error) {
        console.error("Failed to unblock user:", error);
    }
  });

  socket.on('admin_get_report_details', async ({ reportId }) => {
    if (!isAdmin(socket)) return;
    try {
        const [reportRows] = await dbPool.execute("SELECT * FROM user_reports WHERE id = ?", [reportId]);
        if (reportRows.length === 0) return;
        
        const report = reportRows[0];
        const [callRows] = await dbPool.execute("SELECT * FROM call_sessions WHERE call_id = ?", [report.call_id]);
        const [chatLogs] = await dbPool.execute("SELECT * FROM chat_logs WHERE call_id = ? ORDER BY timestamp ASC", [report.call_id]);
        
        socket.emit('admin_report_details', {
            report,
            call: callRows.length > 0 ? callRows[0] : null,
            chatLogs,
        });

    } catch (error) {
        console.error("Failed to fetch report details:", error);
    }
  });
  
  socket.on('admin_get_user_details', async ({ userId, ipAddress }) => {
      if (!isAdmin(socket)) return;
      try {
          const [reports] = await dbPool.execute(
              "SELECT * FROM user_reports WHERE reported_user_id = ? OR reported_ip_address = ? ORDER BY timestamp DESC",
              [userId, ipAddress]
          );
          const [calls] = await dbPool.execute(
              `SELECT id, call_id, start_time, duration_seconds, 
               IF(user1_id = ?, user2_id, user1_id) as partner_id
               FROM call_sessions 
               WHERE (user1_id = ? OR user2_id = ?) 
               ORDER BY start_time DESC LIMIT 20`,
              [userId, userId, userId]
          );
          const country = await getCountryFromIp(ipAddress);
          
          socket.emit('admin_user_details', {
              user: { id: userId, ip: ipAddress, country: country },
              reports,
              calls,
          });
          
      } catch (error) {
          console.error("Failed to fetch user details:", error);
      }
  });

  socket.on('admin_send_warning', async ({ userId, message }) => {
      if (!isAdmin(socket)) return;
      
      const targetSocket = findSocketByIpOrId(null, userId);

      if (targetSocket) {
          targetSocket.emit('receive_admin_warning', { message });
          await dbPool.execute(
              "INSERT INTO admin_warnings (admin_id, user_id, message) VALUES (?, ?, ?)",
              [socket.userId, userId, message]
          );
          console.log(`Admin ${socket.userId} sent warning to ${userId}`);
      } else {
          console.log(`Could not find active socket for user ${userId} to send warning.`);
      }
  });

  socket.on('admin_send_chat_message', ({ to, message }) => {
      if (!isAdmin(socket)) return;
      const targetSocket = findSocketByIpOrId(null, to);
      if (targetSocket) {
          targetSocket.emit('user_receive_admin_chat_message', { from: socket.userId, message });
      }
  });

  socket.on('user_send_admin_chat_message', ({ message }) => {
      io.sockets.sockets.forEach(s => {
          if (isAdmin(s)) {
              s.emit('admin_receive_chat_message', { from: socket.userId, message });
          }
      });
  });

  // --- Admin Secret Join Signaling ---
  socket.on('admin_join_call', ({ callId }) => {
      if (!isAdmin(socket)) return;
      const call = callSessions[callId];
      if (call) {
          socket.join(callId);
          call.admin = socket.id; // Store admin socket id in the session
          console.log(`Admin ${socket.id} secretly joined call ${callId}`);
          
          // Request offers from both users for the admin
          call.users.forEach(userSocketId => {
              const userSocket = io.sockets.sockets.get(userSocketId);
              if (userSocket) {
                  userSocket.emit('admin_request_offer', { adminSocketId: socket.id });
              }
          });
      }
  });

  socket.on('admin_forward_offer_to_admin', ({ to, sdp }) => {
      const adminSocket = io.sockets.sockets.get(to);
      if (adminSocket) {
          adminSocket.emit('admin_receive_offer_from_user', { from: socket.userId, sdp });
      }
  });

  socket.on('admin_forward_answer_to_user', ({ to, sdp }) => {
      const userSocket = findSocketByIpOrId(null, to);
      if (userSocket) {
          userSocket.emit('admin_receive_answer_from_admin', { sdp });
      }
  });

  socket.on('admin_forward_ice_to_admin', ({ to, candidate }) => {
      const adminSocket = io.sockets.sockets.get(to);
      if (adminSocket) {
          adminSocket.emit('admin_receive_ice_from_user', { from: socket.userId, candidate });
      }
  });

  socket.on('admin_forward_ice_to_user', ({ to, candidate }) => {
      const userSocket = findSocketByIpOrId(null, to);
      if (userSocket) {
          userSocket.emit('admin_receive_ice_from_admin', { candidate });
      }
  });


  socket.on('join_queue', (metadata) => {
    findPartnerAndMatch(socket, metadata);
  });
  
  socket.on('next_call', (metadata) => {
    for (const callId in callSessions) {
      if (callSessions[callId].users.includes(socket.id)) {
        dbPool.execute('UPDATE call_sessions SET end_time = CURRENT_TIMESTAMP, duration_seconds = TIMESTAMPDIFF(SECOND, start_time, CURRENT_TIMESTAMP) WHERE call_id = ?', [callId]);
        socket.to(callId).emit('partner_skipped');
        delete callSessions[callId];
        break;
      }
    }
    findPartnerAndMatch(socket, metadata);
  });
  
  socket.on('end_call', () => {
    for (const callId in callSessions) {
      if (callSessions[callId].users.includes(socket.id)) {
        dbPool.execute('UPDATE call_sessions SET end_time = CURRENT_TIMESTAMP, duration_seconds = TIMESTAMPDIFF(SECOND, start_time, CURRENT_TIMESTAMP) WHERE call_id = ?', [callId]);
        socket.to(callId).emit('call_ended');
        delete callSessions[callId];
        console.log(`Call session ${callId} ended.`);
        break;
      }
    }
  });

  socket.on('chat_message', async (data) => {
    const moderationResult = moderateMessage(data.message);
    const { callId, message } = data;
    const ipAddress = socket.handshake.address;
    
    // Forward chat to secret admin if present
    const call = callSessions[callId];
    if (call && call.admin) {
        const adminSocket = io.sockets.sockets.get(call.admin);
        if (adminSocket) {
            adminSocket.emit('admin_live_chat_message', { from: socket.userId, message });
        }
    }

    try {
      const country = await getCountryFromIp(ipAddress);
      await dbPool.execute(
        'INSERT INTO chat_logs (call_id, user_id, ip_address, country, message, is_clean, moderation_reason) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [callId, socket.userId, ipAddress, country, message, moderationResult.isClean, moderationResult.reason]
      );
    } catch (dbError) {
      console.error('Failed to log message to database:', dbError);
    }

    if (moderationResult.isClean) {
      socket.to(callId).emit('chat_message', { sender: 'partner', message: message });
    } else {
      socket.emit('moderation_alert', { message: 'Your message was flagged for moderation.', reason: moderationResult.reason });
    }
  });
  
  socket.on('report_user', async (data) => {
    const { callId, reason } = data;
    if (!reason) return; 

    const session = callSessions[callId];
    if (!session) return;

    const reporterSocketId = socket.id;
    const reportedSocketId = session.users.find(id => id !== reporterSocketId);

    if (!reportedSocketId) return;

    const reporterSocket = io.sockets.sockets.get(reporterSocketId);
    const reportedSocket = io.sockets.sockets.get(reportedSocketId);

    if(!reporterSocket || !reportedSocket) return;

    const reporterUserId = reporterSocket.userId;
    const reportedUserId = reportedSocket.userId;
    const reportedIpAddress = session.ips[reportedSocketId];

    try {
        await dbPool.execute(
            'INSERT INTO user_reports (call_id, reporter_user_id, reported_user_id, reported_ip_address, reason) VALUES (?, ?, ?, ?, ?)',
            [callId, reporterUserId, reportedUserId, reportedIpAddress, reason]
        );
        console.log(`User ${reporterUserId} reported user ${reportedUserId} from IP ${reportedIpAddress} for reason: ${reason}`);
        
        const REPORT_THRESHOLD = 10;
        const TIMEFRAME_HOURS = 1;

        const [reportRows] = await dbPool.execute(
            'SELECT COUNT(*) as count FROM user_reports WHERE reported_ip_address = ? AND timestamp > NOW() - INTERVAL ? HOUR',
            [reportedIpAddress, TIMEFRAME_HOURS]
        );
        const reportCount = reportRows[0].count;

        if (reportCount >= REPORT_THRESHOLD) {
            const blockDurationHours = 24;
            const blockReason = `Auto-blocked for receiving ${reportCount} reports in ${TIMEFRAME_HOURS} hour(s).`;
            await dbPool.execute(
                `INSERT INTO blocked_ips (ip_address, reason, block_expires_at) VALUES (?, ?, NOW() + INTERVAL ? HOUR)
                 ON DUPLICATE KEY UPDATE reason=VALUES(reason), block_expires_at=VALUES(block_expires_at)`,
                [reportedIpAddress, blockReason, blockDurationHours]
            );
            console.log(`IP ${reportedIpAddress} auto-blocked for ${blockDurationHours} hours due to multiple reports.`);

            const targetSocket = findSocketByIpOrId(reportedIpAddress, reportedUserId);
            if (targetSocket) {
                targetSocket.emit('error', 'IP Blocked');
                targetSocket.disconnect(true);
                console.log(`Disconnected blocked user at IP ${reportedIpAddress}`);
            }
        }
    } catch (dbError) {
        console.error('Failed to log report:', dbError);
    }
  });

  // WebRTC signaling events
  socket.on('offer', (data) => socket.to(data.callId).emit('offer', { sdp: data.sdp }));
  socket.on('answer', (data) => socket.to(data.callId).emit('answer', { sdp: data.sdp }));
  socket.on('ice-candidate', (data) => socket.to(data.callId).emit('ice-candidate', { candidate: data.candidate }));

  socket.on('leave_queue', () => {
    let index = mainUserQueue.findIndex(user => user.socketId === socket.id);
    if(index !== -1) mainUserQueue.splice(index, 1);
    index = adultUserQueue.findIndex(user => user.socketId === socket.id);
    if(index !== -1) adultUserQueue.splice(index, 1);
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    onlineUsersCount--;
    io.emit('online_users_count', onlineUsersCount);
  	delete authenticatedUsers[socket.id]; 

  	dbPool.execute('UPDATE connections SET disconnect_time = CURRENT_TIMESTAMP WHERE socket_id = ?', [socket.id]);
  	
  	let index = mainUserQueue.findIndex(user => user.socketId === socket.id);
  	if(index !== -1) mainUserQueue.splice(index, 1);
  	index = adultUserQueue.findIndex(user => user.socketId === socket.id);
  	if(index !== -1) adultUserQueue.splice(index, 1);
  	
  	for (const callId in callSessions) {
  		if (callSessions[callId].users.includes(socket.id)) {
  			dbPool.execute('UPDATE call_sessions SET end_time = CURRENT_TIMESTAMP, duration_seconds = TIMESTAMPDIFF(SECOND, start_time, CURRENT_TIMESTAMP) WHERE call_id = ?', [callId]);
  			socket.to(callId).emit('call_ended');
  			delete callSessions[callId];
  			console.log(`Call session ${callId} ended due to disconnect.`);
  			break;
  		}
  	}
  });

});

const PORT = process.env.PORT || 5000;

// --- Server Startup ---
async function startServer() {
  	await initDb();
  	await loadConfigAndSeed();
  	server.listen(PORT, () => {
  		console.log(`Server is running on port ${PORT}`);
  	});
}

startServer();

