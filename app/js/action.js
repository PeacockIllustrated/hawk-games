import { auth } from './auth.js';
import { applyActionCode, sendEmailVerification } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";

document.addEventListener('DOMContentLoaded', () => {
    const actionTitle = document.getElementById('action-title');
    const actionMessage = document.getElementById('action-message');
    const actionLinks = document.getElementById('action-links');

    const params = new URLSearchParams(window.location.search);
    const mode = params.get('mode');
    const oobCode = params.get('oobCode');

    switch (mode) {
        case 'verifyEmail':
            handleVerifyEmail(oobCode);
            break;
        case 'resetPassword':
            // Placeholder for password reset
            actionTitle.textContent = 'Password Reset';
            actionMessage.textContent = 'Password reset functionality is not yet implemented.';
            addLink('Go to Homepage', 'index.html');
            break;
        default:
            actionTitle.textContent = 'Invalid Action';
            actionMessage.textContent = 'The action is invalid or the link has expired.';
            addLink('Go to Homepage', 'index.html');
    }

    function handleVerifyEmail(code) {
        if (!code) {
            actionTitle.textContent = 'Invalid Link';
            actionMessage.textContent = 'The verification link is missing necessary information.';
            addLink('Go to Homepage', 'index.html');
            return;
        }

        applyActionCode(auth, code)
            .then(() => {
                actionTitle.textContent = 'Success!';
                actionMessage.textContent = 'Your email has been verified. Redirecting to the homepage...';
                setTimeout(() => {
                    window.location.href = 'index.html';
                }, 3000);
            })
            .catch((error) => {
                console.error('Email verification failed:', error);
                actionTitle.textContent = 'Verification Failed';
                actionMessage.textContent = 'This link is invalid or has expired.';
                addLink('Resend Verification Email', '#', resendVerificationEmail);
                addLink('Go to Homepage', 'index.html');
            });
    }

    async function resendVerificationEmail(event) {
        event.preventDefault();
        const user = auth.currentUser;
        if (user) {
            try {
                await sendEmailVerification(user);
                actionMessage.textContent = 'A new verification email has been sent to your address.';
            } catch (error) {
                actionMessage.textContent = 'Failed to send a new verification email. Please try again later.';
            }
        } else {
            actionMessage.textContent = 'You must be logged in to resend a verification email.';
        }
    }

    function addLink(text, href, clickHandler) {
        const link = document.createElement('a');
        link.href = href;
        link.textContent = text;
        link.className = 'btn';
        if (clickHandler) {
            link.addEventListener('click', clickHandler);
        }
        actionLinks.appendChild(link);
    }
});
