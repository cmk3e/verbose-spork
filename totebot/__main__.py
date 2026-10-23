import os

import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "totebot.web:app_factory",
        factory=True,
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8000")),
        proxy_headers=True,
    )
