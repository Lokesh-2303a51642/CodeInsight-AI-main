const nodemailer = require("nodemailer");

function getTransporter() {
  if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    return nodemailer.createTransport({
      host: process.env.EMAIL_HOST || "smtp.gmail.com",
      port: parseInt(process.env.EMAIL_PORT || "587"),
      secure: false,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });
  }
  return null;
}

async function sendPasswordResetEmail(toEmail, resetUrl) {
  const transporter = getTransporter();

  if (!transporter) {
    console.log(`\n📧 [DEV] Password reset link for ${toEmail}:\n${resetUrl}\n`);
    return { success: true, devMode: true };
  }

  try {
    await transporter.sendMail({
      from: `"CodeInsight AI" <${process.env.EMAIL_USER}>`,
      to: toEmail,
      subject: "Reset your CodeInsight AI password",
      html: `
        <div style="font-family:'Inter',sans-serif;max-width:580px;margin:0 auto;border-radius:12px;overflow:hidden;border:1px solid #1c1c32;">
          <div style="background:linear-gradient(135deg,#7c3aed,#a855f7);padding:32px;text-align:center;">
            <div style="width:44px;height:44px;background:rgba(255,255,255,0.2);border-radius:10px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:12px;font-size:22px;">⌨</div>
            <h1 style="color:white;margin:0;font-size:22px;font-weight:700;">CodeInsight AI</h1>
          </div>
          <div style="background:#0f0f1a;padding:36px 32px;">
            <h2 style="color:#e2e8f0;font-size:18px;margin-bottom:12px;">Reset your password</h2>
            <p style="color:#94a3b8;line-height:1.6;margin-bottom:28px;">
              Click the button below to reset your password. This link expires in <strong style="color:#e2e8f0;">1 hour</strong>.
            </p>
            <a href="${resetUrl}" style="display:inline-block;background:#7c3aed;color:white;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:600;font-size:15px;">Reset Password</a>
            <p style="color:#4a5568;font-size:12px;margin-top:28px;">If you didn't request a password reset, you can safely ignore this email.</p>
          </div>
        </div>
      `,
      text: `Reset your CodeInsight AI password: ${resetUrl}\n\nThis link expires in 1 hour.\n\nIf you didn't request this, ignore this email.`,
    });
    return { success: true, devMode: false };
  } catch (err) {
    console.error("Email error:", err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { sendPasswordResetEmail };
