# locketlam

The authentication, client metadata and photo posting protocol in
`src/services/locket.service.js` and `src/services/locket-device.js` is adapted
from locketlam 1.0.2 by LAMDev x DaLyMMO.com:
https://github.com/leanhminh2104/locketlam/tree/1cc48f80a3ad59e1ecbecacbd5358af6f03b55b5

The adaptation uses Node.js, fetch and sharp, and adds server-side sessions,
response validation, timeouts, storage URL checks and verified download tokens.
It covers authentication and photo posting; other SDK modules are not included.

MIT License

Copyright (c) 2026 LAMDev x DaLyMMO.com

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
