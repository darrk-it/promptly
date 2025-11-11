## This is a Discord bot built with Node.js and discord.js that allows users to:

- Save a **custom prompt** and **OpenAI API key** (encrypted per user)
- Run `/chat` with a prompt
- Securely store user data in `user_data.json` on a persistent disk (Pella compatible)
- Use `/setprompt`, `/setkey`, `/deleteprompt`, `/deletekey`, `/help`, and `/info` commands

## Features

- User specific storage for OpenAI keys and prompts
- Secure encryption using AES-256
- Works 24/7 on Pella with persistent disk
- Ephemeral messages for sensitive commands
