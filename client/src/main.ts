/// <reference path="typings/whatwg-fetch/whatwg-fetch.d.ts" />

type SongID = string
type AlbumID = string

// Fisher-Yates Shuffle
function shuffle<T>(array: T[]): T[] {
    let counter = array.length
    let temp: T
    let index: number

    // While there are elements in the array
    while(counter > 0) {
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

class Album {
    id: AlbumID
    title: string
    year: string
    tracks: SongID[]
}

class Song {
    constructor(public id: SongID, public title: string) {}

    stream() {
        return `/music/song/${this.id}/stream`
    }

    static parse(data: any) {
        return new Song(data.id, data.title)
    }
}

class MediaLibrary {
    private root: string
    private songs: SongID[]
    private albums: AlbumID[]

    songCache: Map<SongID, Song>
    albumCache: Map<AlbumID, Album>

    artistIndex: Map<string, SongID[]>
    albumIndex: Map<SongID, AlbumID>

    constructor(root: string) {
        this.root = root

        this.songs = []
        this.albums = []

        this.songCache = new Map<SongID, Song>()
        // this.albumCache = new Map<AlbumID, Album>()

        // this.artistIndex = new Map<string, SongID[]>()
        // this.albumIndex = new Map<SongID, AlbumID>()
    }

    refresh() {
        const songs: SongID[] = []
        const albums = new Set<SongID>()
        const songCache = new Map<SongID, Song>()

        return self.fetch(`${this.root}/music/songs`).then((response) => {
            return response.json()
        }).then((results) => {
            for(let rawSong of results) {
                songs.push(rawSong.id)
                albums.add(rawSong.album)
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
            console.error(err)
        })
    }

    shuffle() {
        return this.refresh().then(() => {
            shuffle(this.songs)
            return this.songs
        })
    }

    songUrl(song: Song): string {
        return this.root + song.stream()
    }

    getSong(id: SongID) {
        if(this.songCache.has(id)) {
            return this.songCache.get(id)
        } else {
            return null
        }
    }
}

class Player {
    playing: Song

    element: HTMLAudioElement
    library: MediaLibrary
    playlist: Song[]

    onplay: (song: Song)=>void

    constructor(element: HTMLAudioElement, library: MediaLibrary) {
        this.playing = null
        this.element = element
        this.library = library
        this.playlist = []

        this.element.controls = false
        this.element.onended = () => {
            this.doPlay()
        }
        this.element.onerror = () => {
            const id = this.playing? this.playing.id : 'unknown'
            console.error(`Error playing ${id}`)
            this.doPlay()
        }

        this.onplay = (song) => {}
    }

    play(songs: Song[]) {
        this.playlist = songs
        this.doPlay()
    }

    skip() {
        this.doPlay()
    }

    doPlay() {
        this.playing = null
        if(this.playlist.length === 0) {
            this.onplay(null)
            return
        }

        const song = this.playlist.pop()
        this.playing = song
        this.element.src = this.library.songUrl(song)
        this.element.play()

        this.onplay(song)
    }
}

function main() {
    const labelElement = document.createElement('div')
    const audioElement = document.createElement('audio')
    const playButton = document.createElement('button')
    playButton.innerHTML = 'Play'
    const skipButton = document.createElement('button')
    skipButton.innerHTML = 'Skip'

    const library = new MediaLibrary('/api')
    const player = new Player(audioElement, library)
    player.onplay = (song) => {
        const title = song? song.title : ''
        labelElement.textContent = title
    }

    library.shuffle().then((ids) => ids.map((id) => {
        return library.getSong(id)
    })).then((songs) => {
        playButton.addEventListener('click', function() {
            player.play(songs)
        })

        skipButton.addEventListener('click', function() {
            player.skip()
        })
    })

    const container = document.getElementById('root-container')
    container.appendChild(audioElement)
    container.appendChild(labelElement)
    container.appendChild(playButton)
    container.appendChild(skipButton)
}

window.addEventListener('DOMContentLoaded', function() {
    main()
})
