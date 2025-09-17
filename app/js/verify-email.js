import { auth } from './auth.js';
import { sendEmailVerification } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";

document.addEventListener('DOMContentLoaded', () => {
    const userEmailEl = document.getElementById('user-email');
    const resendBtn = document.getElementById('resend-verification-btn');
    const messageEl = document.getElementById('message');

    auth.onAuthStateChanged(user => {
        if (user) {
            userEmailEl.textContent = user.email;
            resendBtn.disabled = false;
        } else {
            userEmailEl.textContent = 'your email address';
            resendBtn.disabled = true;
        }
    });

    resendBtn.addEventListener('click', async () => {
        if (auth.currentUser) {
            try {
                await sendEmailVerification(auth.currentUser);
                messageEl.textContent = 'A new verification email has been sent.';
                resendBtn.disabled = true;
                setTimeout(() => {
                    messageEl.textContent = '';
                    resendBtn.disabled = false;
                }, 30000); // Prevent spamming
            } catch (error) {
                messageEl.textContent = 'Error sending verification email. Please try again later.';
                console.error('Error sending verification email:', error);
            }
        }
    });
});
