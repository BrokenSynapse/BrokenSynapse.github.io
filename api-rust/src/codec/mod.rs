use serde::Serialize;

#[derive(Clone, Copy, Debug, Serialize)]
pub enum Codec {
    Json = 1,
    MessagePackReserved = 2,
    CborReserved = 3,
}

// Runtime packets will move to MessagePack or CBOR after the object model settles.
// JSON remains the bootstrap/debug codec so the migration is easy to inspect.
