# Usa una imagen oficial de Node.js
FROM node:24

# Establece el directorio de trabajo en el contenedor
WORKDIR /app

# Copia los archivos de dependencias
COPY package*.json ./

# Instala las dependencias
RUN npm install

# Copia el resto del código
COPY . .

# Expone el puerto usado por la app
EXPOSE 3000

# Comando para arrancar la app
CMD ["npm", "run", "dev"]