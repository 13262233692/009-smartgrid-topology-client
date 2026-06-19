use crate::models::SubstationEvent;
use futures_util::{SinkExt, StreamExt};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite::Message;

pub async fn run_server(port: u16, mut rx: broadcast::Receiver<SubstationEvent>) {
    let addr: SocketAddr = format!("0.0.0.0:{port}").parse().unwrap();
    let listener = match TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[server] failed to bind to {addr}: {e}");
            return;
        }
    };

    eprintln!("[server] WebSocket listening on ws://{addr}");

    let clients: Arc<tokio::sync::Mutex<Vec<tokio::sync::mpsc::Sender<Message>>>> =
        Arc::new(tokio::sync::Mutex::new(Vec::new()));

    let clients_accept = clients.clone();
    let accept_handle = tokio::spawn(async move {
        loop {
            let (stream, peer) = match listener.accept().await {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("[server] accept error: {e}");
                    continue;
                }
            };

            let ws_stream = match tokio_tungstenite::accept_async(stream).await {
                Ok(ws) => ws,
                Err(e) => {
                    eprintln!("[server] WebSocket handshake failed for {peer}: {e}");
                    continue;
                }
            };

            eprintln!("[server] client connected: {peer}");

            let (ws_sink, mut ws_stream_rx) = ws_stream.split();
            let (tx, mut rx_from_server) = tokio::sync::mpsc::channel::<Message>(8192);

            {
                let mut cs = clients_accept.lock().await;
                cs.push(tx);
            }

            let peer_str = peer.to_string();
            let clients_remove = clients_accept.clone();
            tokio::spawn(async move {
                while let Some(msg) = ws_stream_rx.next().await {
                    match msg {
                        Ok(Message::Close(_)) | Err(_) => break,
                        _ => {}
                    }
                }
            });

            let clients_remove2 = clients_remove.clone();
            let peer_str2 = peer_str.clone();
            tokio::spawn(async move {
                let mut ws_sink = ws_sink;
                while let Some(msg) = rx_from_server.recv().await {
                    if ws_sink.send(msg).await.is_err() {
                        break;
                    }
                }
                eprintln!("[server] client disconnected: {peer_str2}");
                let mut cs = clients_remove2.lock().await;
                cs.retain(|c| !c.is_closed());
            });
        }
    });

    let clients_broadcast = clients.clone();
    let broadcast_handle = tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    let json = match serde_json::to_string(&event) {
                        Ok(j) => j,
                        Err(e) => {
                            eprintln!("[server] serialize error: {e}");
                            continue;
                        }
                    };

                    let msg = Message::Text(json.into());
                    let mut cs = clients_broadcast.lock().await;
                    cs.retain(|c| {
                        if c.is_closed() {
                            false
                        } else {
                            c.try_send(msg.clone()).is_ok()
                        }
                    });
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    eprintln!("[server] broadcast lagged, skipped {n} messages");
                }
                Err(broadcast::error::RecvError::Closed) => {
                    eprintln!("[server] broadcast channel closed");
                    break;
                }
            }
        }
    });

    let _ = tokio::try_join!(accept_handle, broadcast_handle);
}
