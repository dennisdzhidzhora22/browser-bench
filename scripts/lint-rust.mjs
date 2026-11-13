// cargo fmt --check, then clippy with warnings as errors, in kernels/.
import { cargo } from './cargo.mjs';

cargo(['fmt', '--check']);
cargo(['clippy', '--release', '--', '-D', 'warnings']);
