pub const STATE_READ: &str = "state:read";
pub const STATE_WRITE: &str = "state:write";
pub const DEBUG_READ: &str = "debug:read";

pub fn known() -> &'static [&'static str] {
    &[STATE_READ, STATE_WRITE, DEBUG_READ]
}
