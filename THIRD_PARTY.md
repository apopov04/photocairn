# Third-party components

Photocairn bundles the following so it can run fully offline, with no requests to other servers.

## ONNX Runtime Web (`vendor/ort/`)
- Version 1.30.0, from https://github.com/microsoft/onnxruntime
- MIT License, © Microsoft Corporation. See `vendor/ort/LICENSE`.

## ag-psd (`vendor/ag-psd/`)
- Version 31.0.3, from https://github.com/Agamnentzar/ag-psd
- MIT License. See `vendor/ag-psd/LICENSE`. Used for opening and saving Photoshop files. It is loaded only when a PSD is opened or saved.

## U²-Net background-removal models (`models/`)
- `u2netp.onnx` ("Fast") is the small U²-Net model by Xuebin Qin et al.: https://github.com/xuebinqin/U-2-Net (Apache License 2.0).
- `silueta.onnx.part*` ("Best quality") is a compact U²-Net variant distributed by the rembg project: https://github.com/danielgatis/rembg (MIT License). It is split into two files so each stays under static-hosting size limits; the app joins them in the browser.
- The ONNX exports come from the rembg project's releases.

> Qin, X., Zhang, Z., Huang, C., Dehghan, M., Zaiane, O. R., & Jagersand, M. (2020). *U²-Net: Going deeper with nested U-structure for salient object detection.* Pattern Recognition, 106, 107404.

## Phosphor Icons (`js/icons.js`)
- Regular weight, from https://phosphoricons.com (`@phosphor-icons/core` 2.1.1)
- MIT License, © Phosphor Icons. Only the icons Photocairn uses are inlined, so nothing is loaded from other servers.

## Font library (`vendor/fonts/library/`)
- 50 free font families from the Google Fonts collection (https://github.com/google/fonts), all under the SIL Open Font License 1.1; each folder has its `LICENSE.txt`. Hosted on this site and loaded only when used: Arimo (stand-in for Arial, Helvetica), Tinos (stand-in for Times New Roman), Cousine (stand-in for Courier New), Carlito (stand-in for Calibri), Caladea (stand-in for Cambria), Gelasio (stand-in for Georgia), EB Garamond (stand-in for Garamond), Archivo Narrow (stand-in for Arial Narrow), Roboto, Open Sans, Source Sans 3, Lato, Inter, Noto Sans, Montserrat, Poppins, Nunito Sans, Work Sans, IBM Plex Sans, PT Sans, Fira Sans, Barlow, DM Sans, Manrope, Public Sans, Raleway, Mulish, Rubik, Merriweather, Lora, Libre Baskerville, Crimson Pro, PT Serif, Source Serif 4, Noto Serif, Playfair Display, Libre Caslon Text, Cormorant Garamond, Spectral, IBM Plex Serif, Source Code Pro, Roboto Mono, IBM Plex Mono, JetBrains Mono, Oswald, Bebas Neue, Dancing Script, Caveat, Great Vibes, Pacifico.
