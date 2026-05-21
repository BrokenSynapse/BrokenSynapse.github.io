use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::core;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LmiAddressKind {
    System,
    Shell,
    Module,
    User,
    Entity,
    Asset,
    Server,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct LmiAddress {
    pub kind: LmiAddressKind,
    pub id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LmiRefKind {
    Asset,
    Entity,
    Blob,
    Module,
    File,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct LmiRef {
    pub kind: LmiRefKind,
    pub id: String,
    pub mime: Option<String>,
    pub size: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct LmiPacket {
    pub id: String,
    pub op: i64,
    pub source: LmiAddress,
    pub target: Option<LmiAddress>,
    pub scope: String,
    pub flags: i64,
    pub ts: i64,
    pub rev: Option<i64>,
    pub payload: Option<Value>,
    pub refs: Option<Vec<LmiRef>>,
}

impl LmiPacket {
    pub fn response_to(request: &LmiPacket, payload: Value) -> Self {
        Self {
            id: format!("srv-{}", core::unix_ms()),
            op: super::opcodes::MSG_RESPONSE,
            source: LmiAddress {
                kind: LmiAddressKind::Server,
                id: "api-r".to_string(),
            },
            target: Some(request.source.clone()),
            scope: request.scope.clone(),
            flags: 0,
            ts: core::unix_ms(),
            rev: request.rev,
            payload: Some(payload),
            refs: None,
        }
    }
}
