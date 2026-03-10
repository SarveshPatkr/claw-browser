FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        chromium \
        curl \
        dbus-x11 \
        dumb-init \
        fonts-liberation \
        fonts-noto-color-emoji \
        fonts-noto-core \
        imagemagick \
        plank \
        picom \
        openbox \
        libglib2.0-0 \
        libcairo2 \
        libpango-1.0-0 \
        libpangocairo-1.0-0 \
        libgdk-pixbuf-2.0-0 \
        libgtk-3-0 \
        librsvg2-common \
        novnc \
        procps \
        socat \
        websockify \
        x11-apps \
        x11-utils \
        x11vnc \
        xvfb \
        wmctrl \
        feh \
        obconf \
        nitrogen \
        python3-xdg \
        tint2 \
    && useradd --create-home --uid 10001 --shell /bin/bash browser \
    && mkdir -p /home/browser/.config/chromium \
    && mkdir -p /home/browser/extensions/tab-to-window \
    && mkdir -p /home/browser/.config/gtk-2.0 \
    && mkdir -p /home/browser/.config/gtk-3.0 \
    && mkdir -p /home/browser/.config/openbox \
    && mkdir -p /home/browser/.config/tint2 \
    && mkdir -p /home/browser/.config/plank/dock1/launchers \
    && mkdir -p /tmp/.X11-unix \
    && chmod 1777 /tmp/.X11-unix \
    && chown -R browser:browser /home/browser \
    && rm -rf /var/lib/apt/lists/*

COPY scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY scripts/healthcheck.sh /usr/local/bin/healthcheck.sh
COPY scripts/workspace-manager.py /usr/local/bin/workspace-manager.py
COPY scripts/focus-chromium-window /usr/local/bin/focus-chromium-window
COPY scripts/launch-app.sh /usr/local/bin/launch-app
COPY config/wallpaper.jpg /usr/share/novnc/wallpaper.jpg
COPY config/Xresources /home/browser/.Xresources
COPY config/gtk-2.0/gtkrc /home/browser/.config/gtk-2.0/gtkrc
COPY config/gtk-3.0/settings.ini /home/browser/.config/gtk-3.0/settings.ini
COPY config/chromium/extensions/tab-to-window/manifest.json /home/browser/extensions/tab-to-window/manifest.json
COPY config/chromium/extensions/tab-to-window/background.js /home/browser/extensions/tab-to-window/background.js
COPY config/openbox/rc.xml /home/browser/.config/openbox/rc.xml
COPY config/openbox/autostart /home/browser/.config/openbox/autostart
COPY config/picom.conf /home/browser/.config/picom.conf
COPY config/tint2/tint2rc /home/browser/.config/tint2/tint2rc
COPY config/plank/dock1/dock.conf /home/browser/.config/plank/dock1/dock.conf
COPY config/plank/dock1/launchers/chromium.dockitem /home/browser/.config/plank/dock1/launchers/chromium.dockitem
COPY config/wallpaper.jpg /home/browser/wallpaper.jpg

# Copy React client to noVNC folder
COPY client/dist/ /usr/share/novnc/

RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/healthcheck.sh /usr/local/bin/focus-chromium-window /usr/local/bin/launch-app \
    && chmod +x /usr/local/bin/workspace-manager.py \
    && mkdir -p /usr/share/novnc/workspaces /usr/share/novnc/tabs \
    && chmod +x /home/browser/.config/openbox/autostart \
    && chown -R browser:browser /home/browser /usr/share/novnc/workspaces /usr/share/novnc/tabs

ENV HOME=/home/browser
WORKDIR /home/browser

EXPOSE 6080 5900 9222 8080

USER browser

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=5 \
  CMD ["/usr/local/bin/healthcheck.sh"]

ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/entrypoint.sh"]
