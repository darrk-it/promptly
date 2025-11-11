## This is a Discord bot built with Node.js and discord.js that allows users to:

- Save a **prompt ID** and **OpenAI API key** (encrypted per user)
- Run `/chat` with a prompt
- Securely store user data in `user_data.json` on a persistent disk (Render compatible)
- Use `/setprompt`, `/setkey`, `/deleteprompt`, `/deletekey`, and `/help` commands

## Features

- Per-user storage for OpenAI keys and prompt IDs
- Secure encryption using AES-256
- Works 24/7 on Render with persistent disk
- Ephemeral messages for sensitive commands