# Colorir PDF

App Android para pintar livros de colorir em PDF.

- **Estante**: adicione quantos PDFs quiser; cada um aparece com a capa (primeira página), o progresso
  e pode ser ordenado por mais recentes, abertos por último ou nome. O menu ⋮ renomeia ou exclui.
- **Páginas**: miniaturas de todas as páginas do livro; as já pintadas ficam marcadas.
- **Pintura**: caneta, marcador, lápis, giz, aquarela, spray, glitter, balde (preenche a área cercada
  pelas linhas), borracha e pegar cor. Tamanho e opacidade por ferramenta, desfazer/refazer,
  zoom e movimento com dois dedos. A tinta fica por baixo do traço do desenho.
- **Cores**: paleta de 796 cores (importada de `paleta_de_cores.bin`, formato ibisPaint), cores
  recentes e um seletor para criar qualquer cor.
- Tudo é salvo automaticamente no aparelho; o botão ↓ exporta a página pintada para
  `Imagens/ColorirPDF` na galeria. O app funciona sem internet.

## Instalar

Copie `dist/ColorirPDF.apk` para o celular, abra o arquivo e permita "instalar apps desconhecidos"
quando o Android pedir. Requer Android 7.0 ou mais novo.

## Estrutura

| Caminho | O que é |
| --- | --- |
| `web/` | Toda a interface (HTML/CSS/JS). `vendor/` traz o pdf.js 3.11 (Apache-2.0). |
| `src/.../MainActivity.java` | Casca nativa: WebView, seletor de arquivos e gravação na galeria. |
| `build.sh` | Gera o APK só com ferramentas do apt (sem Gradle/Android Studio). |
| `debug.keystore` | Chave de assinatura de desenvolvimento (senha `android`). É mantida no repositório para que novas versões instalem **por cima** da anterior sem perder as pinturas. |

Para testar a interface no computador: `python3 -m http.server --directory web` e abra no navegador.

## Limitações conhecidas

- As pinturas ficam guardadas dentro do app: desinstalar o app (ou limpar os dados dele) apaga a
  estante. Exporte para a galeria o que quiser guardar.
- O balde depende de linhas fechadas; em desenhos com falhas no contorno a cor pode "vazar"
  — só as linhas do próprio PDF seguram a tinta. Use desfazer e pinte essa área com um pincel.

## Publicar como site (app instalável)

A pasta `web/` é um site estático completo e instalável (PWA): tem `manifest.webmanifest`, ícones e
`sw.js`, que guarda o app no aparelho para abrir sem internet. Qualquer hospedagem com HTTPS serve.

- **Hostinger**: no hPanel, abra o Gerenciador de Arquivos, entre em `public_html` (ou numa subpasta,
  ex. `public_html/colorir`), envie `dist/colorir-pdf-site.zip` e extraia ali. O `.htaccess` já vai junto.
  Ou, de uma sessão com o token da API da Hostinger configurado:
  `python3 deploy_hostinger.py <usuario> <dominio> colorir web` (envia `web/` para `public_html/colorir`).
- **Firebase Hosting**: `firebase.json` aponta para `web/`. Com o Firebase CLI:
  `firebase deploy --only hosting --project <id-do-projeto>` dentro de `colorir-app/`.

No iPhone: abrir o endereço no Safari → Compartilhar → "Adicionar à Tela de Início".
No Android: abrir no Chrome → menu ⋮ → "Instalar app".

Ao publicar uma versão nova, aumente o número de `CACHE` em `web/sw.js`.
