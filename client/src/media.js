// Fisher-Yates Shuffle
function shuffle(array) {
    let counter = array.length
    let temp
    let index

    // While there are elements in the array
    while (counter > 0) {
        // Pick a random index
        index = Math.floor(Math.random() * counter)
        counter -= 1

        // And swap the last element with it
        temp = array[counter]
        array[counter] = array[index]
        array[index] = temp
    }

    return array
}

export class Album {
    constructor(id, title, albumArtist, year, tracks, haveCover) {
        this.id = id
        this.title = title
        this.albumArtist = albumArtist
        this.year = year
        this.tracks = tracks

        this.haveCover = haveCover
        this.cover = null
        this.thumbnail = null
    }

    getCover(library) {
        if(!this.haveCover) {
            return new Promise((resolve, reject) => { resolve(null) })
        }

        if(this.cover) {
            return new Promise((resolve, reject) => { resolve(this.cover) })
        }

        return self.fetch(`${library.root}/music/album/${this.id}/cover`).then((response) => {
            if(!response.ok) { return null }
            return response.blob()
        }).then((data) => {
            this.cover = data
            return data
        })
    }

    getThumbnail(library) {
        if(!this.haveCover) {
            return new Promise((resolve, reject) => { resolve(null) })
        }

        if(this.thumbnail) {
            return new Promise((resolve, reject) => { resolve(this.thumbnail) })
        }

        return self.fetch(`${library.root}/music/album/${this.id}/thumbnail`).then((response) => {
            if(!response.ok) { return null }
            return response.blob()
        }).then((data) => {
            this.thumbnail = data
            return data
        })
    }

    compare(other) {
        const thisCompiler = this.albumArtist.toLowerCase().split(/^"|the\W/i).join('')
        const otherCompiler = other.albumArtist.toLowerCase().split(/^"|the\W/i).join('')

        if(thisCompiler > otherCompiler) { return 1 }
        if(thisCompiler < otherCompiler) { return -1 }

        // Tie-break using year
        if(this.year > other.year) { return 1 }
        if(this.year < other.year) { return -1 }

        return 0
    }

    static parse(data) {
        return new Album(data.id, data.title, data.album_artist, data.year, data.tracks, data.cover)
    }
}

export class Song {
    constructor(id, title, artist) {
        this.id = id
        this.title = title
        this.artist = artist
    }

    stream() {
        return `/music/song/${this.id}/stream`
    }

    static parse(data) {
        return new Song(data.id, data.title, data.artist)
    }
}

export class MediaLibrary {
    constructor(root) {
        this.root = root

        this.songs = []
        this.albums = []

        this.songCache = new Map()
        this.albumCache = new Map()

        // this.artistIndex = new Map()
        this.albumIndex = new Map()
    }

    refresh() {
        const songs = []
        const albums = new Set()
        const songCache = new Map()

        return self.fetch(`${this.root}/music/songs`).then((response) => {
            return response.json()
        }).then((results) => {
            for(const rawSong of results) {
                songs.push(rawSong.id)
                albums.add(rawSong.album)
                this.albumIndex.set(rawSong.id, rawSong.album)

                try {
                    songCache.set(rawSong.id, Song.parse(rawSong))
                } catch(err) {
                    console.error(`Error parsing song ${rawSong.id}`)
                    console.error(err)
                }
            }

            this.songs = songs
            this.albums = Array.from(albums.keys())
            this.songCache = songCache
        }).catch((err) => {
            console.error('Invalid response from server', err)
        })
    }

    shuffle() {
        return this.refresh().then(() => {
            shuffle(this.songs)
            return this.songs
        })
    }

    songUrl(song) {
        return this.root + song.stream()
    }

    getSong(id) {
        if(this.songCache.has(id)) {
            return this.songCache.get(id)
        } else {
            return null
        }
    }

    getAlbums() {
        return self.fetch(`${this.root}/music/albums`).then((response) => {
            return response.json()
        }).then((data) => {
            const albums = []
            for(let i = 0; i < data.length; i += 1) {
                const album = Album.parse(data[i])
                this.albumCache.set(album.id, album)
                albums.push(album)
            }

            return albums
        })
    }

    getAlbum(id) {
        if(this.albumCache.has(id)) {
            return new Promise((resolve, reject) => { resolve(this.albumCache.get(id)) })
        }

        return self.fetch(`${this.root}/music/album/${id}/metadata`).then((response) => {
            return response.json()
        }).then((data) => {
            const album = Album.parse(data)
            this.albumCache.set(id, album)
            return album
        })
    }

    getAlbumBySong(id) {
        return this.getAlbum(this.albumIndex.get(id))
    }
}
