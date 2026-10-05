# Recuperar a carteira criada pelo Molibra Miner

Quando o Molibra Miner é instalado **sem** um endereço de carteira, o instalador
cria uma carteira nova e minera para ela. A chave secreta dessa carteira fica
**só no computador onde o Miner foi instalado**. Ninguém mais tem uma cópia, nem
a Molibra. Este guia mostra onde ela está e como passar a usar os MOLI.

## 1. Encontre o arquivo da chave

| Sistema | Pasta | Arquivo |
|---|---|---|
| Windows | `%LOCALAPPDATA%\Molibra` (= `C:\Users\<seu usuário>\AppData\Local\Molibra`) | `MY-WALLET-KEEP-SECRET.txt` |
| Mac | `~/Library/Application Support/Molibra` | `MY-WALLET-KEEP-SECRET.txt` |

- **Windows:** tecle **Windows + R**, cole `%LOCALAPPDATA%\Molibra` e tecle Enter.
- **Mac:** no Finder, **Ir → Ir para a Pasta…**, cole `~/Library/Application Support/Molibra`.

O arquivo tem duas linhas que importam:

```
Address     : 0x…   (o endereço que está minerando)
Private key : 0x…   (64 caracteres - a chave secreta)
```

Confira que o **Address** é o mesmo endereço que aparece minerando na janela do
Molibra Miner.

## 2. Faça um backup agora

Copie o arquivo para um pendrive, ou imprima e guarde em lugar seguro. Se o
computador for formatado ou o disco falhar, **os MOLI dessa carteira se perdem**:
não existe outra cópia da chave.

## 3. Importe a carteira na MetaMask

1. MetaMask → **Adicionar conta** → **Importar conta**.
2. Cole a **Private key** do arquivo.
3. Confira que o endereço importado é igual ao **Address** do arquivo.

## 4. Adicione a rede Molibra

Abra **molibra.org/molibra/connect** no navegador da carteira e toque em
"adicionar a Molibra", ou adicione manualmente:

| Campo | Valor |
|---|---|
| Nome da rede | Molibra |
| URL do RPC | `https://molibra.org` |
| ID da cadeia | `20226` |
| Símbolo | `MOLI` |

Os MOLI minerados aparecem no saldo, e a mineração continua pagando nesse endereço.

## Segurança

- **Nunca envie a chave privada a ninguém**: nem a amigos, nem ao suporte, nem à
  Molibra. Quem tem a chave controla os MOLI. A Molibra nunca pede a chave.
- **Não desinstale o Miner** para "consertar" algo antes de fazer o backup. (O
  desinstalador mantém o arquivo, mas o backup vem primeiro.)

## Prefere minerar para a sua própria carteira?

Reinstale o Miner a partir de **molibra.org/download** e digite o endereço da sua
carteira (`0x…`) na tela da carteira. O que já foi minerado continua na carteira
antiga; para mover, importe a chave antiga uma vez (passo 3) e envie os MOLI.

## Se o arquivo não existir

Se o computador foi formatado ou a pasta foi apagada, **não há como recuperar**
os MOLI dessa carteira. A chave nunca saiu daquele computador, por projeto.

---

*English:* the key of a wallet created by the installer is in
`%LOCALAPPDATA%\Molibra\MY-WALLET-KEEP-SECRET.txt` (Windows) or
`~/Library/Application Support/Molibra/MY-WALLET-KEEP-SECRET.txt` (Mac). Back it
up, import the private key in MetaMask, add the Molibra network (chain ID 20226,
RPC https://molibra.org, symbol MOLI). Never share the key; nobody else has a copy.
