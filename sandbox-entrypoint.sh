#!/bin/bash
# Start virtual display for headless rendering (LibreOffice, wkhtmltopdf, Playwright)
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp &
sleep 0.5

# Keep container alive — sandbox-controller runs exec as uid 1000
exec sleep infinity
